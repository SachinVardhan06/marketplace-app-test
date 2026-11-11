#!/usr/bin/env node
'use strict';

/*
 * Agent runner. Launches the two-tab Chrome environment, then hands control to a
 * Claude agent that explores the researcher's own test site, reads the captured
 * traffic, ranks leads per focus area, and writes safe manual test plans for the
 * researcher to run. The agent never sends test payloads itself.
 *
 * Needs ANTHROPIC_API_KEY. Use config.json (testSite, secondTestSite) and:
 *   --goal "..."   what to focus on this run
 *   --oob HOST     an out-of-band host you own, for SSRF/XXE test plans
 *   --turns N      max agent turns (default 40)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { loadConfig, ROOT } = require('./config');
const { buildScope, enforceScope } = require('./scope');
const { launchBrowser, TabManager } = require('./browser');
const { createCapture } = require('./capture');
const { runAgent } = require('./agent/loop');

function extraArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--(goal|oob|turns)$/);
    if (m && argv[i + 1] && !argv[i + 1].startsWith('--')) { out[m[1]] = argv[++i]; }
  }
  return out;
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

async function main(argv = process.argv.slice(2)) {
  const cfg = loadConfig(argv, (m) => console.warn(m));
  const extra = extraArgs(argv);
  fs.mkdirSync(cfg.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const log = (m) => console.log(m);

  const scope = buildScope(cfg);
  const siteList = [cfg.testSite, cfg.secondTestSite].filter(Boolean);
  log(`[scope] allowed hosts: ${scope.allowedHosts.join(', ')}`);
  if (!siteList.length) {
    log('[env] no test site configured. Set testSite (and secondTestSite) in config.json to your own *.atlassian.net sites.');
    return { stopped: 'no-site' };
  }

  const trafficFile = path.join(cfg.outDir, `traffic-${stamp}.jsonl`);
  const capture = createCapture(trafficFile, { siteHosts: scope.siteHosts, log });

  const context = await launchBrowser(cfg, log);
  await enforceScope(context, scope, log);
  const tabs = new TabManager(context, {
    log, navTimeoutMs: cfg.navTimeoutMs, retries: cfg.retries,
    onNewPage: (name, page) => { if (name !== 'recon') capture.attach(page); },
  });
  context.on('page', (p) => { const r = tabs.tabs.get('recon'); if (!r || r.page !== p) capture.attach(p); });

  await tabs.open('recon', `${cfg.marketplaceBase}/`, { reuse: context.pages()[0] });
  await tabs.open('target', cfg.testSite);

  const agentCfg = {
    siteList, oobHost: extra.oob || null,
    goal: extra.goal, maxTurns: extra.turns ? Number(extra.turns) : 40, delayMs: cfg.delayMs,
  };

  let result;
  try {
    result = await runAgent({
      cfg: agentCfg, tabs, scope, trafficFile, outDir: cfg.outDir, log,
      onAssistant: (text) => log(`\n[agent] ${text}\n`),
      ask: (q) => prompt(`\n[agent asks] ${q}\n> `),
    });
  } finally {
    await capture.close();
    const plans = result && result.tools ? result.tools.state.plans.length : 0;
    const reports = result && result.tools ? result.tools.state.reports.length : 0;
    log(`[agent] done (${result ? result.stopped : 'error'}): ${plans} test plan(s), ${reports} report draft(s) in ${path.relative(ROOT, cfg.outDir)}`);
    await context.close().catch(() => {});
  }
  return result;
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { main };
