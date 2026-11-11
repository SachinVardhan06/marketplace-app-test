'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('./mock-server');
const { main, toCsv, redact } = require('../src/hunt');
const { buildScope } = require('../src/scope');

test('scope allows marketplace and own site, blocks other tenants', () => {
  const s = buildScope({ testSite: 'https://mine.atlassian.net', marketplaceBase: 'https://marketplace.atlassian.com' });
  assert.ok(s.isAllowed('https://marketplace.atlassian.com/apps/1'));
  assert.ok(s.isAllowed('https://mine.atlassian.net/jira'));
  assert.ok(!s.isAllowed('https://someone-else.atlassian.net/'));
  assert.ok(!s.isAllowed('https://vendor-backend.example.com/'));
});

test('redacts auth headers and writes csv', () => {
  assert.deepStrictEqual(redact({ Cookie: 'a', accept: 'b' }), { Cookie: '[redacted]', accept: 'b' });
  assert.strictEqual(toCsv([{ a: 'x,y', b: 1 }]), 'a,b\n"x,y",1\n');
});

test('two tabs open, recon keeps only bug bounty apps, traffic captured', async () => {
  const server = await start();
  const base = `http://127.0.0.1:${server.address().port}`;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-out-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-prof-'));
  try {
    const { apps } = await main([
      '--headless', '--marketplace-base', base, '--site', `${base}/my-site`,
      '--out', out, '--profile', profile, '--delay', '10', '--config', '/nonexistent.json',
    ]);
    assert.strictEqual(apps.length, 1);
    assert.strictEqual(apps[0].key, 'com.example.bounty-app');
    assert.strictEqual(apps[0].vendor, 'Example Vendor');
    assert.strictEqual(apps[0].listingUrl, `${base}/apps/1/bounty-app`);
    const files = fs.readdirSync(out);
    for (const prefix of ['recon-', 'traffic-', 'hosts-']) {
      assert.ok(files.some((f) => f.startsWith(prefix)), `missing ${prefix} file`);
    }
    const traffic = fs.readFileSync(path.join(out, files.find((f) => f.startsWith('traffic-'))), 'utf8');
    assert.match(traffic, /my-site/);
  } finally {
    server.close();
  }
});
