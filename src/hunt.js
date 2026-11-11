#!/usr/bin/env node
'use strict';

/*
 * Two-tab Chrome environment for Atlassian Marketplace bug bounty work.
 *
 *   Tab 1 "recon"  - passive recon on public Marketplace listings: finds apps that
 *                    take part in the Marketplace bug bounty and walks their listing pages.
 *   Tab 2 "target" - YOUR OWN Atlassian test site, where you install apps and test them
 *                    by hand. All traffic from this tab is logged so you can review the
 *                    app's endpoints afterwards.
 *
 * This tool does not send attack payloads, fuzz, or scan. It only reads public data and
 * records traffic you generate yourself. Testing must follow the program rules on Bugcrowd.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { buildScope, enforceScope, hostOf } = require('./scope');
const { searchApps, sleep } = require('./marketplace');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASE = 'https://marketplace.atlassian.com';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function loadConfig(args) {
  const file = args.config ? path.resolve(args.config) : path.join(ROOT, 'config.json');
  let cfg = {};
  if (fs.existsSync(file)) cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const merged = {
    testSite: null, query: '', hosting: 'cloud', maxApps: 25, bugBountyOnly: true,
    delayMs: 2000, openListingsInTab: true, extraAllowedHosts: [], ...cfg,
  };
  if (args.site) merged.testSite = args.site;
  if (args.query) merged.query = args.query;
  if (args.max) merged.maxApps = Number(args.max);
  if (args.all) merged.bugBountyOnly = false;
  if (args['no-listings']) merged.openListingsInTab = false;
  if (args.delay) merged.delayMs = Number(args.delay);
  merged.headless = Boolean(args.headless);
  merged.marketplaceBase = args['marketplace-base'] || DEFAULT_BASE;
  merged.outDir = path.resolve(args.out || path.join(ROOT, 'output'));
  merged.profileDir = path.resolve(args.profile || path.join(ROOT, '.profile'));
  // Never go faster than one request per second against real Atlassian hosts.
  if (merged.marketplaceBase === DEFAULT_BASE) merged.delayMs = Math.max(merged.delayMs, 1000);
  if (merged.testSite && /YOUR-OWN-TEST-SITE/i.test(merged.testSite)) merged.testSite = null;
  return merged;
}

function toCsv(rows) {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

const SENSITIVE = /^(cookie|set-cookie|authorization|x-atlassian-token|proxy-authorization)$/i;
function redact(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[k] = SENSITIVE.test(k) ? '[redacted]' : v;
  return out;
}

async function launchChrome(cfg, log) {
  const opts = { headless: cfg.headless, viewport: null, args: ['--start-maximized'] };
  try {
    // Prefer the real Google Chrome if it is installed.
    const ctx = await chromium.launchPersistentContext(cfg.profileDir, { ...opts, channel: 'chrome' });
    log('[env] launched Google Chrome');
    return ctx;
  } catch {
    const ctx = await chromium.launchPersistentContext(cfg.profileDir, opts);
    log('[env] Google Chrome not found, launched Playwright Chromium');
    return ctx;
  }
}

function captureTraffic(page, file, scope, log) {
  const stream = fs.createWriteStream(file, { flags: 'a' });
  const hosts = new Map();
  page.on('response', async (res) => {
    const req = res.request();
    const h = hostOf(req.url());
    if (!h) return;
    hosts.set(h, (hosts.get(h) || 0) + 1);
    stream.write(JSON.stringify({
      t: new Date().toISOString(),
      method: req.method(),
      url: req.url(),
      status: res.status(),
      type: req.resourceType(),
      frame: req.frame() === page.mainFrame() ? 'main' : 'iframe',
      thirdParty: h !== scope.siteHost && !h.endsWith('atlassian.com') && !h.endsWith('atl-paas.net'),
      requestHeaders: redact(req.headers()),
    }) + '\n');
  });
  return {
    hosts,
    close: () => new Promise((r) => stream.end(r)),
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'));
    return;
  }
  const cfg = loadConfig(args);
  fs.mkdirSync(cfg.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const log = (m) => console.log(m);

  const scope = buildScope(cfg);
  log(`[scope] allowed hosts: ${scope.allowedHosts.join(', ')}`);
  if (!cfg.testSite) log('[env] no testSite set: tab 2 stays blank. Put your own *.atlassian.net test site in config.json');

  const context = await launchChrome(cfg, log);
  await enforceScope(context, scope, log);

  // Tab 1: recon. Tab 2: your own test site.
  const recon = context.pages()[0] || (await context.newPage());
  const target = await context.newPage();

  const traffic = captureTraffic(target, path.join(cfg.outDir, `traffic-${stamp}.jsonl`), scope, log);
  if (cfg.testSite) {
    await target.goto(cfg.testSite, { waitUntil: 'domcontentloaded' }).catch((e) => log(`[target] ${e.message}`));
  } else {
    await target.setContent('<h2>Tab 2: target</h2><p>Set <code>testSite</code> in config.json to your own Atlassian test site.</p>');
  }

  await recon.bringToFront();
  await recon.goto(new URL('/', cfg.marketplaceBase).toString(), { waitUntil: 'domcontentloaded' })
    .catch((e) => log(`[recon] ${e.message}`));

  const apps = await searchApps(context.request, {
    base: cfg.marketplaceBase, query: cfg.query, hosting: cfg.hosting,
    maxApps: cfg.maxApps, delayMs: cfg.delayMs, bugBountyOnly: cfg.bugBountyOnly, log,
  });
  const jsonFile = path.join(cfg.outDir, `recon-${stamp}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify(apps, null, 2));
  fs.writeFileSync(path.join(cfg.outDir, `recon-${stamp}.csv`), toCsv(apps));
  log(`[recon] ${apps.length} app(s) saved to ${path.relative(ROOT, jsonFile)}`);

  if (cfg.openListingsInTab) {
    for (const app of apps) {
      log(`[recon] opening ${app.name} (${app.key})`);
      await recon.goto(app.listingUrl, { waitUntil: 'domcontentloaded' }).catch((e) => log(`[recon] ${e.message}`));
      await sleep(cfg.delayMs);
    }
  }

  const finish = async () => {
    await traffic.close();
    const summary = [...traffic.hosts.entries()].sort((a, b) => b[1] - a[1]);
    fs.writeFileSync(path.join(cfg.outDir, `hosts-${stamp}.json`), JSON.stringify(Object.fromEntries(summary), null, 2));
    log(`[target] hosts seen from tab 2: ${summary.map(([h, n]) => `${h}(${n})`).join(', ') || 'none'}`);
  };

  if (cfg.headless) {
    await finish();
    await context.close();
    return { apps };
  }

  log('[env] Both tabs are open. Test by hand in tab 2; close the browser window when done.');
  await new Promise((resolve) => context.on('close', resolve));
  await finish();
  return { apps };
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { main, parseArgs, loadConfig, toCsv, redact };
