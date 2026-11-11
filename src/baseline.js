#!/usr/bin/env node
'use strict';

/*
 * Builds the PERMISSION BASELINE for the researcher's own test accounts.
 *
 * Every access-control test in the dossier asks the same question: did the app
 * show this account something Jira itself would not? You cannot answer that
 * without first knowing what Jira itself shows. This does that, per site and
 * per account, read-only, and writes output/baseline.json.
 *
 * The useful output is the "control pairs": projects that account A can see and
 * account B cannot. Those are the exact assertions to point the app tests at —
 * if the app ever shows B data from one of those projects, that is the finding,
 * and the baseline is the evidence that B should have seen nothing.
 *
 *   npm run baseline
 */

const fs = require('fs');
const path = require('path');
const { loadConfig, ROOT } = require('./config');
const { buildClients, readCredentials, redactSecrets } = require('./atlassian');

function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

async function profileAccount(client, log) {
  const profile = {
    site: client.site,
    account: client.account.label,
    role: client.account.role,
    accountId: null,
    displayName: null,
    isJiraAdmin: null,
    permissions: {},
    projects: [],
    projectIssueCounts: {},
    errors: [],
  };

  try {
    const me = await client.whoami();
    profile.accountId = me.accountId || null;
    profile.displayName = me.displayName || null;
  } catch (e) {
    profile.errors.push(`whoami: ${e.message}`);
    return profile; // nothing else will work either
  }

  try {
    profile.permissions = await client.permissions();
    profile.isJiraAdmin = profile.permissions.ADMINISTER === true;
  } catch (e) {
    profile.errors.push(`mypermissions: ${e.message}`);
  }

  try {
    profile.projects = await client.projects();
  } catch (e) {
    profile.errors.push(`projects: ${e.message}`);
  }

  for (const p of profile.projects) {
    try {
      const { count, exact, endpoint } = await client.issueCount(`project = "${p.key}"`);
      profile.projectIssueCounts[p.key] = { count, exact, endpoint };
    } catch (e) {
      profile.projectIssueCounts[p.key] = { count: null, error: e.message };
    }
  }

  log(`[baseline] ${client.host} as ${client.account.label} (${profile.displayName || '?'}): `
    + `admin=${profile.isJiraAdmin}, ${profile.projects.length} project(s), ${client.calls} API call(s)`);
  return profile;
}

// Projects one account can see and the other cannot: the control pairs.
function diffSite(profiles) {
  const [a, b] = profiles;
  if (!a || !b) return null;
  const keysOf = (p) => new Set(p.projects.map((x) => x.key));
  const aKeys = keysOf(a);
  const bKeys = keysOf(b);

  const onlyA = [...aKeys].filter((k) => !bKeys.has(k));
  const onlyB = [...bKeys].filter((k) => !aKeys.has(k));

  const controlPairs = onlyA.map((key) => ({
    projectKey: key,
    visibleTo: a.account,
    hiddenFrom: b.account,
    issueCountForVisibleAccount: (a.projectIssueCounts[key] || {}).count ?? null,
    expectedForHiddenAccount: 0,
    note: `If the app shows account ${b.account} any data from ${key}, that is a permission bypass.`,
  }));

  const sharedDivergence = [...aKeys].filter((k) => bKeys.has(k)).map((key) => {
    const ca = (a.projectIssueCounts[key] || {}).count;
    const cb = (b.projectIssueCounts[key] || {}).count;
    return (typeof ca === 'number' && typeof cb === 'number' && ca !== cb)
      ? { projectKey: key, [`count_${a.account}`]: ca, [`count_${b.account}`]: cb }
      : null;
  }).filter(Boolean);

  return {
    projectsOnlyVisibleTo: { [a.account]: onlyA, [b.account]: onlyB },
    controlPairs,
    sharedProjectsWithDifferentVisibleCounts: sharedDivergence,
  };
}

function readiness(sites, accounts, baseline) {
  const notes = [];
  if (accounts.length < 2) notes.push(`Only ${accounts.length} account configured — the access-control tests need two (an admin and a low-privilege user).`);
  if (sites.length < 2) notes.push('Only one site configured — test 5.9 (module-scope tenant bleed) needs a second site.');
  for (const site of baseline.sites) {
    const admins = site.accounts.filter((a) => a.isJiraAdmin === true).map((a) => a.account);
    const nonAdmins = site.accounts.filter((a) => a.isJiraAdmin === false).map((a) => a.account);
    if (!admins.length) notes.push(`${site.host}: neither account is a Jira admin — test 5.1 needs one.`);
    if (!nonAdmins.length) notes.push(`${site.host}: both accounts are Jira admins — you need a genuinely low-privilege second user, or every test passes trivially.`);
    const pairs = site.diff ? site.diff.controlPairs.length : 0;
    if (!pairs) notes.push(`${site.host}: no project is visible to one account and hidden from the other. Create one the low-privilege user cannot browse, or there is nothing to prove a bypass against.`);
  }
  return notes;
}

async function main(argv = process.argv.slice(2)) {
  const cfg = loadConfig(argv, (m) => console.warn(m));
  const log = (m) => console.log(m);
  fs.mkdirSync(cfg.outDir, { recursive: true });

  const accounts = readCredentials();
  const sites = [cfg.testSite, cfg.secondTestSite].filter(Boolean);

  if (!sites.length) {
    log('[baseline] no test site configured. Put your own site in config.json as "testSite".');
    return { ok: false, reason: 'no-site' };
  }
  if (!accounts.length) {
    log('[baseline] no credentials found. Create a .env file beside package.json:');
    log('           ATLASSIAN_EMAIL=you@example.com');
    log('           ATLASSIAN_API_TOKEN=...            # account A (Jira admin)');
    log('           ATLASSIAN_EMAIL_B=other@example.com');
    log('           ATLASSIAN_API_TOKEN_B=...          # account B (low privilege)');
    log('           Tokens: id.atlassian.com/manage-profile/security/api-tokens');
    return { ok: false, reason: 'no-credentials' };
  }

  log(`[baseline] ${accounts.length} account(s) across ${sites.length} site(s); read-only GETs only`);
  const clients = buildClients({ cfg, accounts, log });

  const baseline = { builtAt: new Date().toISOString(), sites: [] };
  for (const site of sites) {
    const siteClients = clients.filter((c) => c.site === site.replace(/\/+$/, ''));
    const profiles = [];
    for (const c of siteClients) profiles.push(await profileAccount(c, log));
    baseline.sites.push({ site, host: siteClients[0] ? siteClients[0].host : null, accounts: profiles, diff: diffSite(profiles) });
  }

  baseline.readiness = readiness(sites, accounts, baseline);
  const file = path.join(cfg.outDir, 'baseline.json');
  writeAtomic(file, redactSecrets(JSON.stringify(baseline, null, 2), accounts));

  for (const site of baseline.sites) {
    const pairs = site.diff ? site.diff.controlPairs : [];
    if (pairs.length) {
      log(`[baseline] ${site.host} control pairs: ${pairs.map((p) => `${p.projectKey} (visible to ${p.visibleTo}, hidden from ${p.hiddenFrom})`).join(', ')}`);
    }
  }
  if (baseline.readiness.length) {
    log('[baseline] not ready yet:');
    for (const n of baseline.readiness) log(`  - ${n}`);
  } else {
    log('[baseline] ready: an admin, a low-privilege account, and at least one project that separates them.');
  }
  log(`[baseline] written to ${path.relative(ROOT, file)}`);
  return { ok: true, baseline, file };
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { main, diffSite, profileAccount, readiness };
