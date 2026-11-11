'use strict';

// Passive recon on public Marketplace data (read-only GETs, rate-limited).
// Primary source is the REST API; if that keeps failing we fall back to reading
// app links from the public search page so a run still produces something.

const { withRetry, HttpError, parseRetryAfter, sleep } = require('./retry');

const MAX_CAP = 200;

// The real shape is programs.bugBountyParticipant.<hosting>.status === 'approved'.
// Searching the block for the text "bugbounty" is wrong: the block is present,
// with "not-a-participant", for apps that take no part at all — so every app
// came back marked as a participant. Participation is per hosting type, and a
// Bugcrowd target is per hosting type too, so check the one we searched for.
const HOSTING_KEYS = { cloud: 'cloud', server: 'server', datacenter: 'dataCenter' };

function bugBountyStatus(addon, hosting) {
  const programs = addon.programs || (addon._embedded && addon._embedded.programs);
  const participant = programs && programs.bugBountyParticipant;
  if (!participant || typeof participant !== 'object') return false;
  const key = hosting ? HOSTING_KEYS[String(hosting).toLowerCase().replace(/[^a-z]/g, '')] : null;
  const keys = key ? [key] : Object.keys(participant);
  return keys.some((k) => participant[k] && participant[k].status === 'approved');
}

function safeUrl(href, base, fallback) {
  try { return new URL(href, base).toString(); } catch { return fallback; }
}

function normalise(addon, base, hosting) {
  const e = addon._embedded || {};
  const alt = addon._links && addon._links.alternate && addon._links.alternate.href;
  const fallback = `${base}/apps/${encodeURIComponent(addon.key || '')}`;
  return {
    key: addon.key || null,
    name: addon.name || addon.key || '(unnamed)',
    vendor: (e.vendor && e.vendor.name) || null,
    summary: addon.summary || addon.tagLine || null,
    hosting: addon.hosting || null,
    totalInstalls: (e.distribution && (e.distribution.totalInstalls ?? e.distribution.downloads)) ?? null,
    averageStars: (e.reviews && e.reviews.averageStars) ?? null,
    bugBountyParticipant: bugBountyStatus(addon, hosting),
    listingUrl: alt ? safeUrl(alt, base, fallback) : fallback,
    source: 'api',
  };
}

async function fetchJson(request, url, { retries, log, timeoutMs = 30000 }) {
  return withRetry(async () => {
    const res = await request.get(url, { headers: { accept: 'application/json' }, timeout: timeoutMs });
    if (!res.ok()) throw new HttpError(res.status(), url, parseRetryAfter(res.headers()['retry-after']));
    const text = await res.text();
    try { return JSON.parse(text); } catch { throw new Error(`invalid JSON from ${url}`); }
  }, { retries, label: 'marketplace API', log });
}

// Walks API pages. onPage is called after every page so callers can save as they go.
async function searchApi(request, opts) {
  const { base, query, hosting, maxApps, delayMs, bugBountyOnly, retries, log, startOffset = 0, seen = new Set(), onPage = () => {} } = opts;
  const results = [];
  const cap = Math.min(maxApps, MAX_CAP);
  const pageSize = 50;
  let offset = startOffset;
  let emptyPages = 0;

  while (results.length < cap) {
    const url = new URL('/rest/2/addons', base);
    if (query) url.searchParams.set('text', query);
    if (hosting) url.searchParams.set('hosting', hosting);
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('offset', String(offset));
    log(`[recon] GET ${url}`);
    const body = await fetchJson(request, url.toString(), { retries, log });
    const addons = (body && body._embedded && Array.isArray(body._embedded.addons)) ? body._embedded.addons : [];
    if (addons.length === 0) break;
    let added = 0;
    let consumed = 0;
    for (const a of addons) {
      consumed++;
      if (!a || typeof a !== 'object') continue;
      let app;
      try { app = normalise(a, base, hosting); } catch (e) { log(`[recon] skipped malformed app: ${e.message}`); continue; }
      if (!app.key || seen.has(app.key)) continue;
      if (bugBountyOnly && !app.bugBountyParticipant) continue;
      seen.add(app.key);
      results.push(app);
      added++;
      if (results.length >= cap) break;
    }
    // Only count what we actually looked at, so --resume continues from the right place.
    offset += consumed;
    onPage({ apps: results, offset });
    // Stop if many pages in a row give nothing new (e.g. a narrow filter).
    emptyPages = added === 0 ? emptyPages + 1 : 0;
    if (emptyPages >= 10) { log('[recon] 10 pages with no new matches, stopping'); break; }
    if (results.length >= cap) break;
    if (typeof body.count === 'number' && offset >= body.count) break;
    await sleep(delayMs);
  }
  return { apps: results, offset };
}

// Fallback: read app links from the public search page in the recon tab.
async function searchPage(getPage, { base, query, maxApps, log, navTimeoutMs, seen = new Set() }) {
  const url = new URL('/search', base);
  if (query) url.searchParams.set('query', query);
  log(`[recon] API unavailable, reading ${url} instead`);
  const page = await getPage();
  await withRetry(() => page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: navTimeoutMs }),
    { retries: 3, label: 'search page', log });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  const links = await page.$$eval('a[href*="/apps/"]', (as) => as.map((a) => ({
    href: a.href, text: (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
  }))).catch(() => []);
  const apps = [];
  for (const { href, text } of links) {
    const m = href.match(/\/apps\/(\d+)\/([^/?#]+)/);
    if (!m) continue;
    const key = `listing-${m[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    apps.push({
      key, name: text || m[2], vendor: null, summary: null, hosting: null, totalInstalls: null,
      averageStars: null, bugBountyParticipant: null, listingUrl: href.split('#')[0], source: 'search-page',
    });
    if (apps.length >= Math.min(maxApps, MAX_CAP)) break;
  }
  if (apps.length) log('[recon] bug bounty status is unknown for page results: check each listing before testing');
  return apps;
}

async function searchApps(request, getPage, opts) {
  try {
    return await searchApi(request, opts);
  } catch (e) {
    opts.log(`[recon] API failed after retries: ${e.message}`);
    try {
      return { apps: await searchPage(getPage, opts), offset: opts.startOffset || 0 };
    } catch (e2) {
      opts.log(`[recon] search page fallback failed too: ${e2.message}`);
      return { apps: [], offset: opts.startOffset || 0 };
    }
  }
}

module.exports = { searchApps, searchApi, searchPage, normalise, bugBountyStatus, MAX_CAP };
