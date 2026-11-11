'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { start } = require('./mock-server');
const { main } = require('../src/hunt');
const { TabManager, launchBrowser } = require('../src/browser');
const { baseArgs, outDirOf, tmp } = require('./helpers');

const silence = () => { const orig = console.log; console.log = () => {}; return () => { console.log = orig; }; };

test('two tabs, bug bounty filter, traffic capture and leads', async () => {
  const server = await start();
  const base = `http://127.0.0.1:${server.address().port}`;
  const args = baseArgs(base, ['--site', `${base}/my-site`]);
  const restore = silence();
  try {
    const { apps, files } = await main(args);
    assert.deepStrictEqual(apps.map((a) => a.key), ['com.example.bounty-app']);
    assert.strictEqual(apps[0].listingUrl, `${base}/apps/1/bounty-app`);
    const out = fs.readdirSync(outDirOf(args));
    for (const prefix of ['recon-', 'traffic-', 'hosts-', 'leads-', 'run-']) assert.ok(out.some((f) => f.startsWith(prefix)), `missing ${prefix}`);
    const leads = JSON.parse(fs.readFileSync(files.traffic.replace('traffic-', 'leads-').replace('.jsonl', '.json'), 'utf8')).leads;
    for (const area of ['crossInstance', 'accessControl', 'ssrf', 'xss', 'csrf', 'sqli', 'xxe', 'rce', 'traversal']) {
      assert.ok(leads[area].length > 0, `no ${area} leads from the mock app`);
    }
    assert.ok(leads.xss.some((l) => l.reasons.some((r) => r.includes('reflected'))));
  } finally { restore(); server.close(); }
});

test('survives 429s and 500s from the API', async () => {
  const server = await start({ rateLimitFirst: 2, failFirst: 2 });
  const base = `http://127.0.0.1:${server.address().port}`;
  const restore = silence();
  try {
    const { apps } = await main(baseArgs(base, ['--no-listings']));
    assert.strictEqual(apps.length, 1);
    assert.ok(server.stats.apiHits >= 5);
  } finally { restore(); server.close(); }
});

test('falls back to the search page when the API is down', async () => {
  const server = await start({ apiDown: true });
  const base = `http://127.0.0.1:${server.address().port}`;
  const restore = silence();
  try {
    const { apps } = await main(baseArgs(base, ['--no-listings', '--retries', '1']));
    assert.deepStrictEqual(apps.map((a) => a.key), ['listing-1', 'listing-2']);
    assert.ok(apps.every((a) => a.source === 'search-page' && a.bugBountyParticipant === null));
  } finally { restore(); server.close(); }
});

test('resume continues where the last run stopped', async () => {
  const server = await start();
  const base = `http://127.0.0.1:${server.address().port}`;
  const args = baseArgs(base, ['--no-listings', '--all', '--max', '1']);
  const restore = silence();
  try {
    const first = await main(args);
    assert.strictEqual(first.apps.length, 1);
    const i = args.indexOf('--max');
    args[i + 1] = '5';
    const second = await main([...args, '--resume']);
    assert.deepStrictEqual(second.apps.map((a) => a.key), ['com.example.bounty-app', 'com.example.plain-app']);
    assert.strictEqual(path.basename(second.files.json), path.basename(first.files.json));
  } finally { restore(); server.close(); }
});

test('a closed or crashed tab is reopened at its home page', async () => {
  const server = await start();
  const base = `http://127.0.0.1:${server.address().port}`;
  let context;
  try {
    context = await launchBrowser({ headless: true, profileDir: tmp('hunt-prof-') }, () => {});
    const tabs = new TabManager(context, { log: () => {}, navTimeoutMs: 10000, retries: 2 });
    const page = await tabs.open('target', `${base}/home`);
    await page.close();
    const again = await tabs.page('target');
    assert.notStrictEqual(again, page);
    await again.waitForURL(`${base}/home`);
    assert.strictEqual(new URL(again.url()).pathname, '/home');
  } finally { if (context) await context.close(); server.close(); }
});
