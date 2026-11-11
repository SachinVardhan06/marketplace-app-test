'use strict';

// Records traffic from your own test-site tabs for later review. Nothing here
// modifies or replays requests; it only observes what you do by hand.

const fs = require('fs');
const { hostOf } = require('./scope');

const SENSITIVE_HEADERS = /^(cookie|set-cookie|authorization|proxy-authorization|x-atlassian-token|x-csrf-token|x-xsrf-token)$/i;
const SENSITIVE_PARAMS = /^(jwt|token|access_token|id_token|refresh_token|code|password|passwd|secret|client_secret|api[_-]?key|signature|sig)$/i;
const SKIP_TYPES = new Set(['image', 'font', 'media', 'stylesheet', 'manifest']);
const MAX_BODY_SCAN = 1024 * 1024;
const MAX_POST = 4096;

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) out[k] = SENSITIVE_HEADERS.test(k) ? '[redacted]' : v;
  return out;
}

function redactUrl(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (SENSITIVE_PARAMS.test(k)) u.searchParams.set(k, '[redacted]');
    return u.toString();
  } catch { return url; }
}

// Pulls name/value pairs from the query string and from JSON or form bodies.
function extractParams(url, postData, contentType) {
  const params = [];
  try { for (const [k, v] of new URL(url).searchParams) params.push({ name: k, value: v, in: 'query' }); } catch {}
  if (!postData) return params;
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('json') || /^\s*[{[]/.test(postData)) {
    try {
      const walk = (obj, prefix) => {
        if (obj && typeof obj === 'object') {
          for (const [k, v] of Object.entries(obj)) walk(v, prefix ? `${prefix}.${k}` : k);
        } else if (prefix) params.push({ name: prefix, value: String(obj), in: 'body' });
      };
      walk(JSON.parse(postData), '');
    } catch {}
  } else if (ct.includes('x-www-form-urlencoded')) {
    for (const [k, v] of new URLSearchParams(postData)) params.push({ name: k, value: v, in: 'body' });
  }
  return params.slice(0, 200);
}

function redactParams(params) {
  return params.map((p) => (SENSITIVE_PARAMS.test(p.name.split('.').pop()) ? { ...p, value: '[redacted]' } : p));
}

function isThirdParty(host, siteHosts) {
  if (siteHosts.includes(host)) return false;
  return !(host.endsWith('.atlassian.com') || host.endsWith('.atlassian.net') || host.endsWith('.atl-paas.net')
    || host === 'atlassian.com');
}

function createCapture(file, { siteHosts = [], log = () => {} } = {}) {
  const stream = fs.createWriteStream(file, { flags: 'a' });
  stream.on('error', (e) => log(`[capture] write error: ${e.message}`));
  const hosts = new Map();
  const attached = new WeakSet();
  let closed = false;
  const pending = new Set();

  async function onResponse(page, res) {
    if (closed) return;
    try {
      const req = res.request();
      const url = req.url();
      const host = hostOf(url);
      if (!host || url.startsWith('data:')) return;
      hosts.set(host, (hosts.get(host) || 0) + 1);
      const type = req.resourceType();
      const reqHeaders = req.headers();
      const resHeaders = res.headers();
      const reqCt = reqHeaders['content-type'] || '';
      const resCt = resHeaders['content-type'] || '';
      const postData = req.postData();
      const params = extractParams(url, postData, reqCt);

      // Reflection check: which parameter values appear verbatim in the response.
      let reflected = [];
      if (!SKIP_TYPES.has(type) && /text|json|javascript|xml/i.test(resCt)) {
        const body = await res.text().catch(() => null);
        if (body && body.length <= MAX_BODY_SCAN) {
          reflected = params.filter((p) => p.value && p.value.length >= 4 && body.includes(p.value)).map((p) => p.name);
        }
      }
      if (closed) return;
      let frame = 'unknown';
      try { frame = req.frame() === page.mainFrame() ? 'main' : 'iframe'; } catch {}

      stream.write(JSON.stringify({
        t: new Date().toISOString(),
        method: req.method(),
        url: redactUrl(url),
        host,
        status: res.status(),
        type,
        frame,
        thirdParty: isThirdParty(host, siteHosts),
        requestContentType: reqCt,
        responseContentType: resCt,
        hasAuthHeader: Boolean(reqHeaders.authorization),
        hasCookie: Boolean(reqHeaders.cookie),
        hasCsrfHeader: Object.keys(reqHeaders).some((k) => /csrf|xsrf|atlassian-token/i.test(k)),
        hasJwt: /[?&]jwt=/.test(url) || /^JWT /i.test(reqHeaders.authorization || ''),
        params: redactParams(params),
        reflectedParams: reflected,
        postData: postData ? postData.slice(0, MAX_POST) : null,
        cors: {
          allowOrigin: resHeaders['access-control-allow-origin'] || null,
          allowCredentials: resHeaders['access-control-allow-credentials'] || null,
        },
        requestHeaders: redactHeaders(reqHeaders),
      }) + '\n');
    } catch (e) {
      log(`[capture] skipped a response: ${e.message}`);
    }
  }

  function attach(page) {
    if (attached.has(page)) return;
    attached.add(page);
    page.on('response', (res) => {
      const p = onResponse(page, res).finally(() => pending.delete(p));
      pending.add(p);
    });
  }

  return {
    attach,
    hosts,
    // Let in-flight responses finish writing (up to 5s) before closing the file.
    close: async () => {
      await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, 5000))]);
      closed = true;
      await new Promise((r) => stream.end(r));
    },
  };
}

module.exports = { createCapture, extractParams, redactUrl, redactHeaders, isThirdParty };
