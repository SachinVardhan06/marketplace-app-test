#!/usr/bin/env node
'use strict';

/*
 * Two-tab Chrome environment for Atlassian Marketplace bug bounty work.
 *
 *   Tab 1 "recon"  - passive recon on public Marketplace listings: finds apps in the
 *                    Marketplace bug bounty and walks their listing pages.
 *   Tab 2 "target" - YOUR OWN Atlassian test site, where you install and test apps by
 *                    hand. Traffic from this tab (and any other tab you open, except
 *                    recon) is logged, then sorted into leads per focus area.
 *
 * It sends no payloads and does no scanning. It reads public data and records
 * traffic you generate yourself. Follow the program rules on Bugcrowd.
 */

const fs = require('fs');
const path = require('path');
const { loadConfig, ROOT } = require('./config');
const { buildScope, enforceScope } = require('./scope');
const { searchApps } = require('./marketplace');
const { launchBrowser, TabManager } = require('./browser');
const { createCapture } = require('./capture');
const leadFinder = require('./analyze');
const { sleep } = require('./retry');

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

// Write to a temp file then rename, so a crash never leaves a half-written file.
function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function makeLogger(file) {
  let stream = null;
  try { stream = fs.createWriteStream(file, { flags: 'a' }); stream.on('error', () => { stream = null; }); } catch {}
  const log = (m) => {
    console.log(m);
    if (stream) stream.write(`${new Date().toISOString()} ${m}\n`);
  };
  log.close = () => new Promise((r) => (stream ? stream.end(r) : r()));
  return log;
}

function loadState(cfg) {
  const file = path.join(cfg.outDir, 'state.json');
  if (!cfg.resume || !fs.existsSync(file)) return null;
  try {
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (st.query !== cfg.query || st.hosting !== cfg.hosting || st.bugBountyOnly !== cfg.bugBountyOnly) return null;
    const apps = JSON.parse(fs.readFileSync(path.join(cfg.outDir, `recon-${st.stamp}.json`), 'utf8'));
    return { ...st, apps };
  } catch { return null; }
}

async function main(argv = process.argv.slice(2), { installSignalHandlers = require.main === module } = {}) {
  const cfg = loadConfig(argv, (m) => console.warn(m));
  if (cfg.help) {
    console.log(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'));
    return { apps: [] };
  }
  fs.mkdirSync(cfg.outDir, { recursive: true });

  const state = loadState(cfg);
  const stamp = state ? state.stamp : new Date().toISOString().replace(/[:.]/g, '-');
  const log = makeLogger(path.join(cfg.outDir, `run-${stamp}.log`));
  if (state) log(`[env] resuming run ${stamp} with ${state.apps.length} app(s) at offset ${state.offset}`);

  const scope = buildScope(cfg);
  log(`[scope] allowed hosts: ${scope.allowedHosts.join(', ')}`);
  if (!cfg.testSite) log('[env] no testSite set: tab 2 shows instructions. Put your own *.atlassian.net site in config.json');

  const files = {
    json: path.join(cfg.outDir, `recon-${stamp}.json`),
    csv: path.join(cfg.outDir, `recon-${stamp}.csv`),
    traffic: path.join(cfg.outDir, `traffic-${stamp}.jsonl`),
    hosts: path.join(cfg.outDir, `hosts-${stamp}.json`),
    state: path.join(cfg.outDir, 'state.json'),
  };

  let apps = state ? state.apps : [];
  let lastOffset = state ? state.offset : 0;
  let tabs = null;
  const saveRecon = (offset = lastOffset) => {
    lastOffset = offset;
    try {
      writeAtomic(files.json, JSON.stringify(apps, null, 2));
      writeAtomic(files.csv, toCsv(apps));
      writeAtomic(files.state, JSON.stringify({ stamp, offset, query: cfg.query, hosting: cfg.hosting, bugBountyOnly: cfg.bugBountyOnly }, null, 2));
    } catch (e) { log(`[recon] could not save results: ${e.message}`); }
  };

  const capture = createCapture(files.traffic, { siteHosts: scope.siteHosts, log });

  let context;
  let finished = null;
  const finish = (reason) => {
    if (finished) return finished;
    finished = (async () => {
      log(`[env] shutting down (${reason})`);
      if (tabs) tabs.stopping = true;
      saveRecon();
      await capture.close();
      try {
        const summary = [...capture.hosts.entries()].sort((a, b) => b[1] - a[1]);
        writeAtomic(files.hosts, JSON.stringify(Object.fromEntries(summary), null, 2));
        log(`[target] hosts seen: ${summary.slice(0, 15).map(([h, n]) => `${h}(${n})`).join(', ') || 'none'}`);
        if (fs.existsSync(files.traffic) && fs.statSync(files.traffic).size > 0) {
          const r = leadFinder.run(files.traffic, cfg.outDir);
          log(`[leads] ${r.counts}`);
          log(`[leads] written to ${path.relative(ROOT, r.file)}`);
        }
      } catch (e) { log(`[leads] could not analyse traffic: ${e.message}`); }
      if (context) await context.close().catch(() => {});
      log(`[recon] ${apps.length} app(s) in ${path.relative(ROOT, files.json)}`);
      await log.close();
    })();
    return finished;
  };

  const handlers = [];
  if (installSignalHandlers) {
    const onSignal = (sig) => () => { finish(sig).then(() => process.exit(0)); };
    const onRejection = (e) => log(`[error] unhandled: ${e && e.message ? e.message : e}`);
    const onException = (e) => { log(`[error] fatal: ${e.stack || e}`); finish('fatal error').then(() => process.exit(1)); };
    handlers.push(['SIGINT', onSignal('Ctrl+C')], ['SIGTERM', onSignal('SIGTERM')], ['unhandledRejection', onRejection], ['uncaughtException', onException]);
    for (const [ev, fn] of handlers) process.on(ev, fn);
  }

  try {
    context = await launchBrowser(cfg, log);
    await enforceScope(context, scope, log);

    tabs = new TabManager(context, {
      log, navTimeoutMs: cfg.navTimeoutMs, retries: cfg.retries,
      onNewPage: (name, page) => { if (name !== 'recon') capture.attach(page); },
    });
    // Any tab you open yourself (e.g. your second test site) is captured too.
    context.on('page', (p) => {
      const recon = tabs.tabs.get('recon');
      if (!recon || recon.page !== p) capture.attach(p);
    });
    context.on('close', () => { tabs.contextClosed = true; });

    const firstPage = context.pages()[0];
    await tabs.open('recon', `${cfg.marketplaceBase}/`, { reuse: firstPage });
    if (cfg.testSite) {
      await tabs.open('target', cfg.testSite);
    } else {
      const page = await context.newPage();
      capture.attach(page);
      await page.setContent('<h2>Tab 2: target</h2><p>Set <code>testSite</code> in config.json to your own Atlassian test site, then restart.</p>');
    }
    (await tabs.page('recon')).bringToFront().catch(() => {});

    const seen = new Set(apps.map((a) => a.key));
    const res = await searchApps(context.request, () => tabs.page('recon'), {
      base: cfg.marketplaceBase, query: cfg.query, hosting: cfg.hosting, maxApps: Math.max(0, cfg.maxApps - apps.length),
      delayMs: cfg.delayMs, bugBountyOnly: cfg.bugBountyOnly, retries: cfg.retries, navTimeoutMs: cfg.navTimeoutMs,
      startOffset: state ? state.offset : 0, seen, log,
      onPage: ({ apps: found, offset }) => { apps = [...(state ? state.apps : []), ...found]; saveRecon(offset); },
    });
    apps = [...(state ? state.apps : []), ...res.apps];
    saveRecon(res.offset);
    log(`[recon] ${apps.length} app(s) saved to ${path.relative(ROOT, files.json)}`);

    if (cfg.openListingsInTab) {
      for (const app of apps) {
        if (finished || tabs.contextClosed) break;
        log(`[recon] opening ${app.name} (${app.key})`);
        await tabs.goto('recon', app.listingUrl);
        await sleep(cfg.delayMs);
      }
    }

    if (cfg.headless && cfg.testSite && !finished) {
      // Give the target page's own requests time to finish before closing.
      const target = await tabs.page('target').catch(() => null);
      if (target) await target.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    }

    if (!cfg.headless && !finished && !tabs.contextClosed) {
      log('[env] Both tabs are open. Test by hand in tab 2; close the browser window or press Ctrl+C when done.');
      await new Promise((resolve) => {
        if (tabs.contextClosed) return resolve();
        context.on('close', resolve);
      });
    }
  } catch (e) {
    log(`[error] ${e.message}`);
    await finish('error');
    for (const [ev, fn] of handlers) process.off(ev, fn);
    throw e;
  }

  await finish(cfg.headless ? 'headless run complete' : 'browser closed');
  for (const [ev, fn] of handlers) process.off(ev, fn);
  return { apps, files };
}

if (require.main === module) {
  main().catch(() => process.exit(1));
}

module.exports = { main, toCsv, writeAtomic };
