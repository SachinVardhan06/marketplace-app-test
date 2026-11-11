'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { tmp } = require('./helpers');
const { JiraClient, readCredentials, loadDotEnv, redactSecrets } = require('../src/atlassian');
const { diffSite, readiness } = require('../src/baseline');

const ACCOUNT = { label: 'A', role: 'admin', email: 'a@example.com', token: 'tok-secret-A' };

test('the client refuses any host that is not a configured test site', () => {
  assert.throws(
    () => new JiraClient({ site: 'https://someone-else.atlassian.net', account: ACCOUNT, allowedHosts: ['mine.atlassian.net'] }),
    /refusing to talk to someone-else\.atlassian\.net/,
  );
  assert.throws(() => new JiraClient({ site: 'not a url', account: ACCOUNT, allowedHosts: ['mine.atlassian.net'] }), /invalid site URL/);
  // The allowed one constructs fine.
  const c = new JiraClient({ site: 'https://mine.atlassian.net/', account: ACCOUNT, allowedHosts: ['mine.atlassian.net'] });
  assert.strictEqual(c.host, 'mine.atlassian.net');
  assert.strictEqual(c.site, 'https://mine.atlassian.net');
});

test('the client only ever sends GET, with basic auth', async () => {
  const seen = [];
  const server = await new Promise((r) => {
    const s = http.createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ accountId: 'acc-1', displayName: 'Tester' }));
    });
    s.listen(0, () => r(s));
  });
  const site = `http://127.0.0.1:${server.address().port}`;
  try {
    const c = new JiraClient({ site, account: ACCOUNT, allowedHosts: ['127.0.0.1'], delayMs: 0 });
    const me = await c.whoami();
    assert.strictEqual(me.accountId, 'acc-1');
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].method, 'GET', 'nothing but GET may ever be sent');
    assert.strictEqual(seen[0].url, '/rest/api/3/myself');
    const [scheme, b64] = seen[0].auth.split(' ');
    assert.strictEqual(scheme, 'Basic');
    assert.strictEqual(Buffer.from(b64, 'base64').toString(), 'a@example.com:tok-secret-A');
  } finally { server.close(); }
});

test('issueCount falls back when the newer search endpoint is gone', async () => {
  const hits = [];
  const server = await new Promise((r) => {
    const s = http.createServer((req, res) => {
      hits.push(req.url.split('?')[0]);
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/rest/api/3/search/jql')) { res.statusCode = 404; return res.end('{}'); }
      res.end(JSON.stringify({ total: 42, issues: [{ id: '1' }] }));
    });
    s.listen(0, () => r(s));
  });
  const site = `http://127.0.0.1:${server.address().port}`;
  try {
    const c = new JiraClient({ site, account: ACCOUNT, allowedHosts: ['127.0.0.1'], delayMs: 0, retries: 0 });
    const got = await c.issueCount('project = "X"');
    assert.strictEqual(got.count, 42);
    assert.strictEqual(got.exact, true);
    assert.strictEqual(got.endpoint, 'rest/api/3/search');
    assert.deepStrictEqual(hits, ['/rest/api/3/search/jql', '/rest/api/3/search']);
  } finally { server.close(); }
});

test('credentials come from .env or the environment, never from config', () => {
  const root = tmp('creds-');
  fs.writeFileSync(path.join(root, '.env'), [
    '# a comment',
    'ATLASSIAN_EMAIL=a@example.com',
    'ATLASSIAN_API_TOKEN="tok-a"',
    "ATLASSIAN_EMAIL_B='b@example.com'",
    'ATLASSIAN_API_TOKEN_B=tok-b',
  ].join('\n'));
  const accounts = readCredentials(root, {});
  assert.strictEqual(accounts.length, 2);
  assert.deepStrictEqual(accounts.map((a) => [a.label, a.role, a.email, a.token]), [
    ['A', 'admin', 'a@example.com', 'tok-a'],
    ['B', 'lowpriv', 'b@example.com', 'tok-b'],
  ]);
  // The real environment wins over the file.
  const overridden = readCredentials(root, { ATLASSIAN_EMAIL: 'env@example.com', ATLASSIAN_API_TOKEN: 'env-tok' });
  assert.strictEqual(overridden[0].email, 'env@example.com');
  // An account missing its token is dropped rather than half-configured.
  fs.writeFileSync(path.join(root, '.env'), 'ATLASSIAN_EMAIL=a@example.com\n');
  assert.strictEqual(readCredentials(root, {}).length, 0);
  assert.deepStrictEqual(loadDotEnv(path.join(root, 'missing')), {});
});

test('secrets are stripped before anything is written to disk', () => {
  const text = JSON.stringify({ note: 'tok-secret-A used by a@example.com' });
  const out = redactSecrets(text, [ACCOUNT]);
  assert.ok(!out.includes('tok-secret-A'));
  assert.ok(!out.includes('a@example.com'));
  assert.match(out, /\[redacted-token\]/);
});

test('the diff finds the control pairs the access-control tests need', () => {
  const admin = {
    account: 'A', role: 'admin', isJiraAdmin: true,
    projects: [{ key: 'PUB' }, { key: 'SECRET' }],
    projectIssueCounts: { PUB: { count: 10 }, SECRET: { count: 7 } },
  };
  const low = {
    account: 'B', role: 'lowpriv', isJiraAdmin: false,
    projects: [{ key: 'PUB' }],
    projectIssueCounts: { PUB: { count: 4 } },
  };
  const diff = diffSite([admin, low]);
  assert.deepStrictEqual(diff.projectsOnlyVisibleTo.A, ['SECRET']);
  assert.deepStrictEqual(diff.projectsOnlyVisibleTo.B, []);
  assert.strictEqual(diff.controlPairs.length, 1);
  assert.deepStrictEqual(
    [diff.controlPairs[0].projectKey, diff.controlPairs[0].hiddenFrom, diff.controlPairs[0].issueCountForVisibleAccount, diff.controlPairs[0].expectedForHiddenAccount],
    ['SECRET', 'B', 7, 0],
  );
  // Same project, different visible counts — also worth knowing.
  assert.deepStrictEqual(diff.sharedProjectsWithDifferentVisibleCounts, [{ projectKey: 'PUB', count_A: 10, count_B: 4 }]);
  assert.strictEqual(diffSite([admin]), null);
});

test('readiness says what is still missing before testing can start', () => {
  const ready = readiness(
    ['https://a.atlassian.net', 'https://b.atlassian.net'],
    [{ label: 'A' }, { label: 'B' }],
    { sites: [{ host: 'a.atlassian.net', accounts: [{ account: 'A', isJiraAdmin: true }, { account: 'B', isJiraAdmin: false }], diff: { controlPairs: [{ projectKey: 'SECRET' }] } }] },
  );
  assert.deepStrictEqual(ready, []);

  const notReady = readiness(
    ['https://a.atlassian.net'],
    [{ label: 'A' }],
    { sites: [{ host: 'a.atlassian.net', accounts: [{ account: 'A', isJiraAdmin: true }], diff: { controlPairs: [] } }] },
  );
  assert.ok(notReady.some((n) => /need two/.test(n)), 'one account is not enough');
  assert.ok(notReady.some((n) => /second site/.test(n)));
  assert.ok(notReady.some((n) => /low-privilege/.test(n)));
  assert.ok(notReady.some((n) => /no project is visible to one account and hidden/.test(n)));
});
