#!/usr/bin/env node
'use strict';

/*
 * Lead finder. Reads traffic captured from your own test site and groups the
 * requests into leads for each focus area of the Marketplace bug bounty.
 * A lead is a place worth testing by hand, not a finding. Verify every lead
 * manually, on your own sites, within the program rules.
 */

const fs = require('fs');
const path = require('path');

const FOCUS_AREAS = {
  crossInstance: {
    title: 'Cross-instance data leakage / access',
    how: 'Install the app on both of your own test sites. Repeat the request from site A using site B\'s session or JWT, or swap the tenant id (clientKey, cloudId, baseUrl). Any site A data returned to site B is the bug.',
  },
  accessControl: {
    title: 'Access control / IDOR',
    how: 'Create two users on your own site (admin and basic). Repeat the request as the lower-privileged user, or change the object id to one owned by your other user. Check CORS findings with your own origin.',
  },
  ssrf: {
    title: 'Server-side request forgery (SSRF)',
    how: 'Change the URL value to an out-of-band endpoint you own (e.g. your own interactsh or Burp Collaborator) and watch for a callback from the vendor server. Do not point it at internal or third-party hosts.',
  },
  xss: {
    title: 'Stored / reflected XSS',
    how: 'For reflected values, check the context (HTML, attribute, JS) and whether encoding is applied. For stored content, save a harmless marker such as a unique string with markup on your own site and see where it renders.',
  },
  csrf: {
    title: 'Cross-site request forgery (CSRF)',
    how: 'State-changing requests that rely on cookies and carry no JWT, auth header or anti-CSRF token. Build a test page on a domain you control and confirm the action happens on your own account.',
  },
  sqli: {
    title: 'SQL injection',
    how: 'Look for ids, sort and filter values passed to the vendor backend. Test with a single quote or boolean pair and compare responses. Stop at proof (an error or a behaviour difference). Never dump data.',
  },
  xxe: {
    title: 'XML external entities (XXE)',
    how: 'Requests that send or upload XML. Test with an external entity pointing at an out-of-band host you own. Do not read files beyond what proves the issue.',
  },
  rce: {
    title: 'Server-side remote code execution (RCE)',
    how: 'Template, expression, script and upload parameters. Prove execution with a harmless out-of-band callback or a sleep/math result. Stop as soon as it is proven.',
  },
  traversal: {
    title: 'Path / directory traversal',
    how: 'File, path and download parameters. Try relative paths that stay harmless (for example a known public file) to prove the issue.',
  },
};

const TENANT_PARAM = /^(cloud_?id|client_?key|site_?id|tenant(_?id)?|instance(_?id)?|base_?url|host_?base_?url|org(_?id)?|workspace(_?id)?|account_?id)$/i;
const URL_PARAM = /(url|uri|link|href|src|callback|webhook|endpoint|host|domain|feed|proxy|redirect|return|next|target|image|avatar|icon|import_?from|fetch)$/i;
const SQL_PARAM = /^(id|.*_id|.*Id|sort|sort_?by|order|order_?by|filter|where|query|q|search|column|col|field|group_?by|limit|offset|page)$/;
const XML_CT = /xml/i;
const RCE_PARAM = /(cmd|command|exec|execute|script|expression|expr|eval|code|template|tpl|formula|macro|render|run)$/i;
const PATH_PARAM = /(file|filename|file_?path|path|dir|directory|folder|template|page|include|download|attachment|doc|document|resource|asset|lang|locale)$/i;
const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24,})$/i;
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const STATIC = new Set(['image', 'font', 'media', 'stylesheet', 'manifest']);

function endpointKey(e) {
  try {
    const u = new URL(e.url);
    const segs = u.pathname.split('/').map((s) => (ID_SEGMENT.test(s) ? '{id}' : s));
    return `${e.method} ${u.host}${segs.join('/')}`;
  } catch { return `${e.method} ${e.url}`; }
}

function idSegments(url) {
  try { return new URL(url).pathname.split('/').filter((s) => ID_SEGMENT.test(s)); } catch { return []; }
}

function readTraffic(file) {
  const entries = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* partial last line after a crash */ }
  }
  return entries;
}

// Only the app's own traffic is interesting: vendor hosts (third party) or app iframes.
function isAppTraffic(e) {
  return !STATIC.has(e.type) && (e.thirdParty || e.frame === 'iframe');
}

function analyze(entries) {
  const leads = Object.fromEntries(Object.keys(FOCUS_AREAS).map((k) => [k, new Map()]));
  const add = (area, e, reason) => {
    const key = endpointKey(e);
    const m = leads[area];
    if (!m.has(key)) m.set(key, { endpoint: key, example: e.url, status: e.status, reasons: new Set(), count: 0 });
    const lead = m.get(key);
    lead.reasons.add(reason);
    lead.count++;
  };

  for (const e of entries) {
    if (!e || !e.url || !isAppTraffic(e)) continue;
    const params = Array.isArray(e.params) ? e.params : [];
    const names = params.map((p) => p.name.split('.').pop());
    const vendor = e.thirdParty;

    // Cross-instance: vendor requests that carry a tenant identifier or JWT.
    const tenantParams = names.filter((n) => TENANT_PARAM.test(n));
    if (vendor && (tenantParams.length || e.hasJwt)) {
      add('crossInstance', e, tenantParams.length ? `tenant id in request: ${tenantParams.join(', ')}` : 'JWT-scoped request to vendor backend');
    }

    // Access control: object ids in path or params on vendor endpoints; loose CORS.
    const ids = idSegments(e.url);
    const idParams = names.filter((n) => /(^id$|_id$|Id$)/.test(n));
    if (vendor && (ids.length || idParams.length)) add('accessControl', e, `object id(s): ${[...ids.map(() => 'path'), ...idParams].join(', ')}`);
    if (e.cors && e.cors.allowCredentials === 'true' && e.cors.allowOrigin && e.cors.allowOrigin !== 'null') {
      add('accessControl', e, `CORS allows credentials for origin ${e.cors.allowOrigin}`);
    }

    // SSRF: parameters whose name or value looks like a URL or host.
    for (const p of params) {
      const n = p.name.split('.').pop();
      if (/^https?:\/\//i.test(p.value || '') || (URL_PARAM.test(n) && p.value)) add('ssrf', e, `URL-like parameter: ${p.name}`);
    }

    // XSS: reflected values, and user content being stored by the vendor.
    for (const r of e.reflectedParams || []) add('xss', e, `value of ${r} reflected in response`);
    if (vendor && STATE_CHANGING.has(e.method) && params.some((p) => p.in === 'body' && /[a-z]/i.test(p.value || '') && (p.value || '').length >= 3)) {
      add('xss', e, 'stores text content (check where it renders)');
    }

    // CSRF: cookie-based state change with no token, JWT or auth header.
    if (STATE_CHANGING.has(e.method) && e.hasCookie && !e.hasAuthHeader && !e.hasJwt && !e.hasCsrfHeader) {
      const simple = /x-www-form-urlencoded|multipart|text\/plain/i.test(e.requestContentType || '') || !e.requestContentType;
      add('csrf', e, simple ? 'cookie auth, no token, simple content type' : 'cookie auth, no token');
    }

    // SQLi: id/sort/filter style parameters to vendor backends; 5xx responses.
    const sqlParams = names.filter((n) => SQL_PARAM.test(n));
    if (vendor && sqlParams.length) add('sqli', e, `query-shaped parameter(s): ${[...new Set(sqlParams)].join(', ')}`);
    if (vendor && e.status >= 500) add('sqli', e, `server error ${e.status} (check what input caused it)`);

    // XXE: XML request bodies or XML/SVG/DOCX-style uploads.
    if (XML_CT.test(e.requestContentType || '') || /^\s*<\?xml/i.test(e.postData || '')) add('xxe', e, 'XML request body');
    if (/multipart/i.test(e.requestContentType || '') && /\.(xml|svg|docx|xlsx|pptx|xsd|xsl)/i.test(e.postData || '')) add('xxe', e, 'XML-based file upload');

    // RCE: template/expression/script params and file uploads.
    const rceParams = names.filter((n) => RCE_PARAM.test(n));
    if (vendor && rceParams.length) add('rce', e, `code-like parameter(s): ${rceParams.join(', ')}`);
    if (vendor && /multipart/i.test(e.requestContentType || '')) add('rce', e, 'file upload to vendor backend');

    // Path traversal: file/path params, or values that look like paths.
    for (const p of params) {
      const n = p.name.split('.').pop();
      if (PATH_PARAM.test(n) || /(^|\/)[\w.-]+\.(json|xml|txt|html?|pdf|png|jpe?g|csv|zip|log|conf|ya?ml)$/i.test(p.value || '') || /(^|[\\/])\.\.([\\/]|$)/.test(p.value || '')) {
        add('traversal', e, `path-like parameter: ${p.name}`);
      }
    }
  }

  const out = {};
  for (const [area, m] of Object.entries(leads)) {
    out[area] = [...m.values()]
      .map((l) => ({ ...l, reasons: [...l.reasons] }))
      .sort((a, b) => b.reasons.length - a.reasons.length || b.count - a.count);
  }
  return out;
}

function toMarkdown(leads, meta) {
  const lines = ['# Leads by focus area', '', `Source: ${meta.source}  `, `Requests analysed: ${meta.total}, app requests: ${meta.app}`, '',
    'Leads are places to test by hand, not findings. Test only on your own sites and within the program rules.', ''];
  for (const [area, info] of Object.entries(FOCUS_AREAS)) {
    const list = leads[area] || [];
    lines.push(`## ${info.title} (${list.length})`, '', `_How to check:_ ${info.how}`, '');
    if (!list.length) { lines.push('No leads in this capture.', ''); continue; }
    for (const l of list.slice(0, 50)) {
      lines.push(`- \`${l.endpoint}\` (${l.count}x, last status ${l.status})`);
      for (const r of l.reasons) lines.push(`  - ${r}`);
    }
    if (list.length > 50) lines.push(`- ...and ${list.length - 50} more in the JSON file`);
    lines.push('');
  }
  return lines.join('\n');
}

function newestTraffic(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => /^traffic-.*\.jsonl$/.test(f)).sort();
  return files.length ? path.join(dir, files[files.length - 1]) : null;
}

function run(file, outDir) {
  const entries = readTraffic(file);
  const leads = analyze(entries);
  const base = path.basename(file).replace(/^traffic-/, 'leads-').replace(/\.jsonl$/, '');
  const meta = { source: path.basename(file), total: entries.length, app: entries.filter(isAppTraffic).length };
  fs.writeFileSync(path.join(outDir, `${base}.json`), JSON.stringify({ meta, leads }, null, 2));
  fs.writeFileSync(path.join(outDir, `${base}.md`), toMarkdown(leads, meta));
  const counts = Object.entries(leads).map(([k, v]) => `${k}:${v.length}`).join(' ');
  return { file: path.join(outDir, `${base}.md`), counts, leads };
}

if (require.main === module) {
  const outDir = path.resolve(__dirname, '..', 'output');
  const file = process.argv[2] ? path.resolve(process.argv[2]) : newestTraffic(outDir);
  if (!file || !fs.existsSync(file)) {
    console.error('No traffic file found. Run `npm run hunt` first, or pass a traffic-*.jsonl path.');
    process.exit(1);
  }
  const r = run(file, path.dirname(file));
  console.log(`[leads] ${r.counts}\n[leads] written to ${r.file}`);
}

module.exports = { analyze, run, readTraffic, endpointKey, FOCUS_AREAS, newestTraffic };
