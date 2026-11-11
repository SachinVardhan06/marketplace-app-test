'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmp } = require('./helpers');
const { createTools } = require('../src/agent/tools');
const { systemPrompt } = require('../src/agent/prompt');

// A fake page/tab that records navigation, so we can test scope without a browser.
function fakeTabs(currentUrl) {
  const page = {
    _url: currentUrl,
    url() { return this._url; },
    mainFrame() { return { url: () => this._url }; },
    frames() { return [this.mainFrame()]; },
    async waitForLoadState() {},
    async evaluate() { return { title: 't', url: this._url, text: '', links: [], forms: [] }; },
  };
  return {
    page,
    tabs: new Map(),
    async goto(name, url) { page._url = url; },
    async page_() { return page; },
  };
}

function toolsFor(trafficFile, siteHosts, currentUrl) {
  const ft = fakeTabs(currentUrl);
  const env = {
    tabs: { goto: ft.goto, page: async () => ft.page, tabs: ft.tabs },
    scope: { siteHosts },
    trafficFile,
    outDir: tmp('agent-out-'),
    log: () => {},
    ask: async () => 'answer',
  };
  return { tools: createTools(env), outDir: env.outDir };
}

test('browse and click refuse hosts that are not the researcher\'s own sites', async () => {
  const { tools } = toolsFor('/nope.jsonl', ['mine.atlassian.net'], 'https://mine.atlassian.net/');
  const bad = await tools.run('browse', { url: 'https://someone-else.atlassian.net/' });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.content, /out of scope/);
  const ok = await tools.run('browse', { url: 'https://mine.atlassian.net/wiki' });
  assert.strictEqual(ok.ok, true);
});

test('there is no tool that sends a payload to an app', () => {
  const { tools } = toolsFor('/nope.jsonl', ['mine.atlassian.net'], 'https://mine.atlassian.net/');
  const names = tools.defs.map((d) => d.name);
  for (const forbidden of ['send_test_request', 'fetch', 'http_request', 'exploit', 'fill_form']) {
    assert.ok(!names.includes(forbidden), `unexpected tool ${forbidden}`);
  }
  assert.ok(names.includes('write_test_plan'));
});

test('write_test_plan and draft_report are saved to disk', async () => {
  const { tools, outDir } = toolsFor('/nope.jsonl', ['mine.atlassian.net'], 'https://mine.atlassian.net/');
  const p = await tools.run('write_test_plan', { area: 'xss', hypothesis: 'h', endpoint: 'GET /x', steps: 'mark it', positiveResult: 'marker runs' });
  assert.strictEqual(p.ok, true);
  const r = await tools.run('draft_report', { area: 'xss', title: 'Stored XSS', severity: 'P2', endpoint: 'GET /x', steps: 's', evidence: 'e', impact: 'i' });
  assert.strictEqual(r.ok, true);
  const plans = JSON.parse(fs.readFileSync(path.join(outDir, 'test-plans.json'), 'utf8'));
  const reports = JSON.parse(fs.readFileSync(path.join(outDir, 'reports.json'), 'utf8'));
  assert.strictEqual(plans[0].area, 'xss');
  assert.strictEqual(reports[0].severity, 'P2');
});

test('list_leads and get_traffic read the capture file', async () => {
  const file = path.join(tmp('agent-traffic-'), 'traffic.jsonl');
  fs.writeFileSync(file, JSON.stringify({ method: 'GET', url: 'https://vendor.example/items/5?id=5', host: 'vendor.example', status: 200, type: 'fetch', frame: 'iframe', thirdParty: true, params: [{ name: 'id', value: '5', in: 'query' }], reflectedParams: [] }) + '\n');
  const { tools } = toolsFor(file, ['mine.atlassian.net'], 'https://mine.atlassian.net/');
  const leads = await tools.run('list_leads', { area: 'accessControl' });
  assert.strictEqual(leads.ok, true);
  assert.match(leads.content, /vendor.example/);
  const traffic = await tools.run('get_traffic', { contains: 'items' });
  assert.match(traffic.content, /items/);
});

test('system prompt names the sites, focus areas and the safety rules', () => {
  const s = systemPrompt({ sites: ['https://mine.atlassian.net'], oobHost: 'oob.mine.example' });
  assert.match(s, /mine.atlassian.net/);
  assert.match(s, /oob.mine.example/);
  for (const area of ['Cross-instance', 'SSRF', 'XSS', 'SQL injection', 'traversal']) assert.match(s, new RegExp(area, 'i'));
  assert.match(s, /own sites/i);
  assert.match(s, /stop at proof|stops at proof/i);
});
