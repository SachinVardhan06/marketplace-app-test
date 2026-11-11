'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildScope } = require('../src/scope');
const { toCsv } = require('../src/hunt');
const { redactHeaders, redactUrl, extractParams } = require('../src/capture');
const { withRetry, HttpError, parseRetryAfter } = require('../src/retry');
const { loadConfig } = require('../src/config');
const { normalise, bugBountyStatus } = require('../src/marketplace');
const { analyze, endpointKey } = require('../src/analyze');

test('scope allows marketplace and own sites, blocks other tenants', () => {
  const s = buildScope({ testSite: 'https://mine.atlassian.net', secondTestSite: 'https://mine2.atlassian.net', marketplaceBase: 'https://marketplace.atlassian.com' });
  assert.ok(s.isAllowed('https://marketplace.atlassian.com/apps/1'));
  assert.ok(s.isAllowed('https://mine.atlassian.net/jira'));
  assert.ok(s.isAllowed('https://mine2.atlassian.net/wiki'));
  assert.ok(!s.isAllowed('https://someone-else.atlassian.net/'));
  assert.ok(!s.isAllowed('https://vendor-backend.example.com/'));
  assert.ok(!s.isAllowed('not a url'));
});

test('redaction of headers, url tokens and csv escaping', () => {
  assert.deepStrictEqual(redactHeaders({ Cookie: 'a', Authorization: 'JWT x', accept: 'b' }), { Cookie: '[redacted]', Authorization: '[redacted]', accept: 'b' });
  assert.match(redactUrl('https://v.example/x?jwt=eyJ&id=5'), /jwt=%5Bredacted%5D&id=5/);
  assert.strictEqual(toCsv([{ a: 'x,y', b: 1 }]), 'a,b\n"x,y",1\n');
  assert.strictEqual(toCsv([]), '');
});

test('params are pulled from query, JSON and form bodies', () => {
  const p = extractParams('https://v/x?a=1', '{"user":{"id":7},"name":"n"}', 'application/json');
  assert.deepStrictEqual(p.map((x) => x.name), ['a', 'user.id', 'name']);
  assert.deepStrictEqual(extractParams('https://v/x', 'k=v', 'application/x-www-form-urlencoded').map((x) => x.name), ['k']);
  assert.deepStrictEqual(extractParams('bad', '{broken', 'application/json'), []);
});

test('retry backs off on 5xx/429, stops on 4xx, honours Retry-After', async () => {
  let n = 0;
  const v = await withRetry(async () => { if (++n < 3) throw new HttpError(503, 'u', 0); return 'ok'; }, { baseMs: 1 });
  assert.strictEqual(v, 'ok');
  assert.strictEqual(n, 3);
  n = 0;
  await assert.rejects(withRetry(async () => { n++; throw new HttpError(404, 'u'); }, { baseMs: 1 }));
  assert.strictEqual(n, 1);
  assert.strictEqual(parseRetryAfter('2'), 2000);
  assert.strictEqual(parseRetryAfter(null), null);
});

test('config survives bad values and refuses unsafe settings', () => {
  const warnings = [];
  const cfg = loadConfig(['--config', '/nonexistent.json', '--max', 'abc', '--delay', '5', '--site', 'https://marketplace.atlassian.com'], (m) => warnings.push(m));
  assert.strictEqual(cfg.maxApps, 25);
  assert.strictEqual(cfg.delayMs, 1000, 'real Marketplace is never hit faster than 1 req/s');
  assert.strictEqual(cfg.testSite, null);
  assert.ok(warnings.length >= 2);
  assert.strictEqual(loadConfig(['--config', '/nonexistent.json', '--max', '9999'], () => {}).maxApps, 200);
  assert.strictEqual(loadConfig(['--config', '/nonexistent.json', '--site', 'mine.atlassian.net'], () => {}).testSite, 'https://mine.atlassian.net/');
});

test('normalise copes with odd API shapes', () => {
  assert.strictEqual(bugBountyStatus({ programs: { bugBountyParticipant: {} } }), true);
  assert.strictEqual(bugBountyStatus({}), false);
  const a = normalise({ key: 'k' }, 'https://m');
  assert.strictEqual(a.listingUrl, 'https://m/apps/k');
  assert.strictEqual(a.name, 'k');
});

test('lead finder sorts traffic into focus areas', () => {
  const v = (o) => ({ method: 'GET', status: 200, type: 'fetch', frame: 'iframe', thirdParty: true, params: [], ...o });
  const leads = analyze([
    v({ url: 'https://vendor.example/api/items/123', params: [{ name: 'cloudId', value: 'c1', in: 'query' }] }),
    v({ url: 'https://vendor.example/fetch?url=http://x', params: [{ name: 'url', value: 'http://x', in: 'query' }] }),
    v({ url: 'https://vendor.example/s?q=abcd', params: [{ name: 'q', value: 'abcd', in: 'query' }], reflectedParams: ['q'] }),
    v({ method: 'POST', url: 'https://vendor.example/save', hasCookie: true, requestContentType: 'application/x-www-form-urlencoded', params: [{ name: 'title', value: 'hello', in: 'body' }] }),
    v({ url: 'https://vendor.example/list?sort=name', params: [{ name: 'sort', value: 'name', in: 'query' }] }),
    v({ method: 'POST', url: 'https://vendor.example/import', requestContentType: 'text/xml', postData: '<?xml version="1.0"?><a/>' }),
    v({ url: 'https://vendor.example/render?template=x', params: [{ name: 'template', value: 'x', in: 'query' }] }),
    v({ url: 'https://vendor.example/dl?file=a.pdf', params: [{ name: 'file', value: 'a.pdf', in: 'query' }] }),
    v({ url: 'https://vendor.example/cors', cors: { allowOrigin: 'https://evil.example', allowCredentials: 'true' } }),
    { url: 'https://mine.atlassian.net/rest/api/2/issue/1', method: 'GET', type: 'fetch', frame: 'main', thirdParty: false },
    v({ url: 'https://vendor.example/logo.png', type: 'image' }),
  ]);
  for (const area of ['crossInstance', 'accessControl', 'ssrf', 'xss', 'csrf', 'sqli', 'xxe', 'rce', 'traversal']) {
    assert.ok(leads[area].length > 0, `expected leads for ${area}`);
  }
  assert.strictEqual(endpointKey({ method: 'GET', url: 'https://h/a/123/b/0b5c1f9e-1111-2222-3333-444455556666' }), 'GET h/a/{id}/b/{id}');
  assert.ok(!JSON.stringify(leads).includes('logo.png'), 'static assets ignored');
  assert.ok(!JSON.stringify(leads).includes('mine.atlassian.net'), 'Atlassian main-frame traffic ignored');
});
