#!/usr/bin/env node
'use strict';

/*
 * Replays the SAME read request as both test accounts and reports where they
 * diverge. This is the direct access-control check: if account B gets back data
 * that only account A should see, that is the finding, and the two responses
 * side by side are the evidence.
 *
 *   npm run compare -- /rest/api/3/project/search
 *   npm run compare -- /rest/api/3/issue/SECRET-1 /rest/api/3/project/SECRET
 *
 * Limits, enforced here:
 *   - GET only (the client cannot do anything else).
 *   - Only the configured test sites.
 *   - Paths must be given explicitly and must start with /rest/. Nothing is
 *     guessed, enumerated or fuzzed, and at most 50 paths per run.
 *
 * Take the paths from captured traffic (output/traffic-*.jsonl) or from the
 * baseline's control pairs — not from a wordlist.
 */

const fs = require('fs');
const path = require('path');
const { loadConfig, ROOT } = require('./config');
const { buildClients, readCredentials, redactSecrets } = require('./atlassian');
const { HttpError } = require('./retry');

const MAX_PATHS = 50;

function parsePaths(argv) {
  const out = [];
  for (const a of argv) {
    if (a.startsWith('--')) continue;
    if (!a.startsWith('/rest/')) throw new Error(`"${a}" must start with /rest/ — give an exact path from captured traffic, not a guess`);
    if (!out.includes(a)) out.push(a);
  }
  if (!out.length) throw new Error('give at least one path, e.g. /rest/api/3/project/search');
  if (out.length > MAX_PATHS) throw new Error(`at most ${MAX_PATHS} paths per run (got ${out.length}) — this is not an enumeration tool`);
  return out;
}

// A shape summary, not the payload: enough to see divergence without hoarding
// anyone's issue data in an output file.
function summarise(body) {
  if (body === null || body === undefined) return { type: 'empty' };
  if (Array.isArray(body)) return { type: 'array', length: body.length };
  if (typeof body !== 'object') return { type: typeof body };
  const keys = Object.keys(body);
  const out = { type: 'object', keys: keys.slice(0, 25) };
  if (typeof body.total === 'number') out.total = body.total;
  if (Array.isArray(body.values)) out.valuesLength = body.values.length;
  if (Array.isArray(body.issues)) out.issuesLength = body.issues.length;
  for (const k of ['key', 'id', 'name']) if (typeof body[k] === 'string') out[k] = body[k];
  return out;
}

function countOf(summary) {
  for (const k of ['total', 'valuesLength', 'issuesLength', 'length']) {
    if (typeof summary[k] === 'number') return summary[k];
  }
  return null;
}

async function fetchAs(client, pathname) {
  try {
    const body = await client.get(pathname.replace(/^\//, ''));
    return { ok: true, status: 200, summary: summarise(body) };
  } catch (e) {
    if (e instanceof HttpError) return { ok: false, status: e.status, summary: null };
    return { ok: false, status: null, error: e.message, summary: null };
  }
}

// B getting data where A also got data is the thing to look at. B being denied
// (401/403/404) is correct behaviour for a path only A should reach.
function verdictFor(a, b) {
  if (!a || !b) return { verdict: 'incomplete', detail: 'one account did not answer' };
  if (a.ok && b.ok) {
    const ca = countOf(a.summary);
    const cb = countOf(b.summary);
    if (typeof ca === 'number' && typeof cb === 'number') {
      if (cb === 0 && ca > 0) return { verdict: 'ok', detail: `B sees 0, A sees ${ca}` };
      if (cb < ca) return { verdict: 'partial', detail: `B sees ${cb} of A's ${ca} — check whether those ${cb} are legitimately B's` };
      return { verdict: 'REVIEW', detail: `both accounts got data (A ${ca}, B ${cb}) — if this path is A-only, that is a bypass` };
    }
    return { verdict: 'REVIEW', detail: 'both accounts got a successful response — compare the keys' };
  }
  if (a.ok && !b.ok) return { verdict: 'ok', detail: `B denied with ${b.status ?? b.error}` };
  if (!a.ok && b.ok) return { verdict: 'ODD', detail: `B succeeded where A (${a.status ?? a.error}) did not` };
  return { verdict: 'ok', detail: `neither account could read it (A ${a.status}, B ${b.status})` };
}

async function main(argv = process.argv.slice(2)) {
  const cfg = loadConfig(argv, (m) => console.warn(m));
  const log = (m) => console.log(m);
  const paths = parsePaths(argv);
  fs.mkdirSync(cfg.outDir, { recursive: true });

  const accounts = readCredentials();
  if (accounts.length < 2) {
    log('[compare] needs both accounts configured in .env (see .env.example). Run `npm run baseline` first.');
    return { ok: false, reason: 'need-two-accounts' };
  }
  const sites = [cfg.testSite, cfg.secondTestSite].filter(Boolean);
  if (!sites.length) {
    log('[compare] no test site configured. Put your own site in config.json as "testSite".');
    return { ok: false, reason: 'no-site' };
  }

  const clients = buildClients({ cfg, accounts, log });
  const results = [];

  for (const site of sites) {
    const normalised = site.replace(/\/+$/, '');
    const forSite = clients.filter((c) => c.site === normalised);
    const a = forSite.find((c) => c.account.label === 'A');
    const b = forSite.find((c) => c.account.label === 'B');
    if (!a || !b) continue;

    for (const pathname of paths) {
      const ra = await fetchAs(a, pathname);
      const rb = await fetchAs(b, pathname);
      const { verdict, detail } = verdictFor(ra, rb);
      results.push({ site: normalised, host: a.host, path: pathname, A: ra, B: rb, verdict, detail });
      const mark = verdict === 'REVIEW' || verdict === 'ODD' ? '!!' : '  ';
      log(`${mark} [${verdict}] ${pathname} — ${detail}`);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(cfg.outDir, `compare-${stamp}.json`);
  fs.writeFileSync(file, redactSecrets(JSON.stringify({ ranAt: new Date().toISOString(), paths, results }, null, 2), accounts));

  const flagged = results.filter((r) => r.verdict === 'REVIEW' || r.verdict === 'ODD');
  log(`[compare] ${results.length} comparison(s), ${flagged.length} to review — ${path.relative(ROOT, file)}`);
  if (flagged.length) log('[compare] a flagged path is not yet a finding: check against output/baseline.json that B genuinely should not see it.');
  return { ok: true, results, file };
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { main, summarise, verdictFor, parsePaths, countOf, MAX_PATHS };
