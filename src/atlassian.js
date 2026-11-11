'use strict';

/*
 * Read-only Jira REST client for the researcher's OWN test accounts.
 *
 * Two accounts are configured (conventionally one Jira admin and one
 * low-privilege user). Their job is to establish the PERMISSION BASELINE: what
 * each account can legitimately see in Jira itself. Every access-control test
 * in the dossier has the form "did the app show this account more than Jira
 * would?", and this client supplies the "than Jira would" half.
 *
 * Hard limits, enforced here rather than trusted to a prompt:
 *   - GET only. Any other method throws. This cannot write to anyone's Jira.
 *   - Only the sites in config (testSite / secondTestSite). Any other host throws.
 *   - Rate limited, and retried with backoff on 429/5xx.
 *
 * Credentials are read from the environment, never from config.json and never
 * from an argument, so they stay out of the repo and out of any transcript:
 *   ATLASSIAN_EMAIL        / ATLASSIAN_API_TOKEN          (account A, "admin")
 *   ATLASSIAN_EMAIL_B      / ATLASSIAN_API_TOKEN_B        (account B, "lowpriv")
 * Put them in a .env file beside package.json (it is gitignored) or export them.
 */

const fs = require('fs');
const path = require('path');
const { withRetry, HttpError, parseRetryAfter, sleep } = require('./retry');
const { hostOf } = require('./scope');

const PERMISSIONS_OF_INTEREST = [
  'ADMINISTER',
  'ADMINISTER_PROJECTS',
  'BROWSE_PROJECTS',
  'CREATE_ISSUES',
  'EDIT_ISSUES',
  'MANAGE_SPRINTS_PERMISSION',
];

// Minimal .env reader: KEY=value lines, # comments, optional quotes. No deps.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function readCredentials(root = path.resolve(__dirname, '..'), env = process.env) {
  const file = loadDotEnv(path.join(root, '.env'));
  const pick = (k) => env[k] || file[k];
  const accounts = [];
  const a = { label: 'A', role: 'admin', email: pick('ATLASSIAN_EMAIL'), token: pick('ATLASSIAN_API_TOKEN') };
  const b = { label: 'B', role: 'lowpriv', email: pick('ATLASSIAN_EMAIL_B'), token: pick('ATLASSIAN_API_TOKEN_B') };
  for (const acct of [a, b]) if (acct.email && acct.token) accounts.push(acct);
  return accounts;
}

// Never let a token reach a log line or a saved file.
function redactSecrets(text, accounts) {
  let out = String(text);
  for (const a of accounts) {
    if (a.token) out = out.split(a.token).join('[redacted-token]');
    if (a.email) out = out.split(a.email).join('[redacted-email]');
  }
  return out;
}

class JiraClient {
  constructor({ site, account, allowedHosts, delayMs = 250, retries = 4, log = () => {} }) {
    const host = hostOf(site);
    if (!host) throw new Error(`invalid site URL: ${site}`);
    if (!allowedHosts.includes(host)) {
      throw new Error(`refusing to talk to ${host}: not one of your configured test sites (${allowedHosts.join(', ') || 'none'})`);
    }
    this.site = site.replace(/\/+$/, '');
    this.host = host;
    this.account = account;
    this.delayMs = delayMs;
    this.retries = retries;
    this.log = log;
    this.lastAt = 0;
    this.calls = 0;
  }

  get auth() {
    return `Basic ${Buffer.from(`${this.account.email}:${this.account.token}`).toString('base64')}`;
  }

  async get(pathname, params = {}) {
    const url = new URL(pathname, `${this.site}/`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    if (hostOf(url.toString()) !== this.host) throw new Error(`refusing to leave ${this.host}`);

    const wait = this.lastAt + this.delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastAt = Date.now();
    this.calls++;

    return withRetry(async () => {
      const res = await fetch(url, {
        method: 'GET', // GET only, by construction
        headers: { authorization: this.auth, accept: 'application/json' },
      });
      if (!res.ok) {
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        throw new HttpError(res.status, `${url.pathname}`, retryAfter);
      }
      return res.json();
    }, { retries: this.retries, baseMs: 1000, label: `GET ${url.pathname} as ${this.account.label}`, log: this.log });
  }

  whoami() {
    return this.get('rest/api/3/myself');
  }

  async permissions(projectKey) {
    const params = { permissions: PERMISSIONS_OF_INTEREST.join(',') };
    if (projectKey) params.projectKey = projectKey;
    const body = await this.get('rest/api/3/mypermissions', params);
    const out = {};
    for (const [k, v] of Object.entries(body.permissions || {})) out[k] = Boolean(v.havePermission);
    return out;
  }

  async projects() {
    const all = [];
    let startAt = 0;
    for (let page = 0; page < 20; page++) {
      const body = await this.get('rest/api/3/project/search', { startAt, maxResults: 50 });
      const values = body.values || [];
      all.push(...values.map((p) => ({ id: p.id, key: p.key, name: p.name, type: p.projectTypeKey })));
      if (body.isLast || values.length === 0) break;
      startAt += values.length;
    }
    return all;
  }

  // How many issues this account can see for a JQL query. The newer endpoint
  // replaced the old one, so try it first and fall back; report which answered.
  async issueCount(jql) {
    const attempts = [
      ['rest/api/3/search/jql', { jql, maxResults: 1, fields: 'id' }],
      ['rest/api/3/search', { jql, maxResults: 1, fields: 'id' }],
    ];
    let lastErr;
    for (const [pathname, params] of attempts) {
      try {
        const body = await this.get(pathname, params);
        const count = typeof body.total === 'number'
          ? body.total
          : (Array.isArray(body.issues) ? body.issues.length : null);
        return { count, exact: typeof body.total === 'number', endpoint: pathname };
      } catch (e) {
        lastErr = e;
        // 404/410 means this endpoint is gone on this site; anything else is real.
        if (!(e instanceof HttpError) || ![404, 410].includes(e.status)) throw e;
      }
    }
    throw lastErr;
  }
}

function buildClients({ cfg, accounts, log }) {
  const sites = [cfg.testSite, cfg.secondTestSite].filter(Boolean);
  const allowedHosts = sites.map(hostOf).filter(Boolean);
  const clients = [];
  for (const site of sites) {
    for (const account of accounts) {
      clients.push(new JiraClient({ site, account, allowedHosts, delayMs: Math.max(250, cfg.delayMs || 0) / 4, retries: cfg.retries, log }));
    }
  }
  return clients;
}

module.exports = {
  JiraClient, buildClients, readCredentials, loadDotEnv, redactSecrets, PERMISSIONS_OF_INTEREST,
};
