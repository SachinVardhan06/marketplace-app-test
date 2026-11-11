'use strict';

// Passive recon using the public Marketplace REST API (read-only GETs,
// rate-limited). See https://developer.atlassian.com/platform/marketplace/rest/v2/

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bugBountyStatus(addon) {
  // The exact shape of the programs block has changed over time, so look for
  // any bug-bounty marker rather than a fixed path.
  const programs = addon.programs || (addon._embedded && addon._embedded.programs) || {};
  const text = JSON.stringify(programs).toLowerCase();
  return text.includes('bugbounty') || text.includes('bug_bounty') || text.includes('bug-bounty');
}

function normalise(addon, base) {
  const e = addon._embedded || {};
  const links = addon._links || {};
  const alt = links.alternate && links.alternate.href;
  return {
    key: addon.key,
    name: addon.name,
    vendor: (e.vendor && e.vendor.name) || null,
    summary: addon.summary || addon.tagLine || null,
    hosting: addon.hosting || null,
    totalInstalls: (e.distribution && (e.distribution.totalInstalls ?? e.distribution.downloads)) ?? null,
    averageStars: (e.reviews && e.reviews.averageStars) ?? null,
    bugBountyParticipant: bugBountyStatus(addon),
    listingUrl: alt ? new URL(alt, base).toString() : `${base}/apps/${encodeURIComponent(addon.key)}`,
  };
}

async function searchApps(request, { base, query, hosting, maxApps, delayMs, bugBountyOnly, log }) {
  const results = [];
  const pageSize = 50;
  let offset = 0;
  // Hard cap so the tool can never turn into a bulk crawler.
  const cap = Math.min(maxApps, 200);

  while (results.length < cap) {
    const url = new URL('/rest/2/addons', base);
    if (query) url.searchParams.set('text', query);
    if (hosting) url.searchParams.set('hosting', hosting);
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('offset', String(offset));
    log(`[recon] GET ${url}`);
    const res = await request.get(url.toString(), { headers: { accept: 'application/json' } });
    if (!res.ok()) {
      log(`[recon] API returned ${res.status()}, stopping`);
      break;
    }
    const body = await res.json();
    const addons = (body._embedded && body._embedded.addons) || [];
    if (addons.length === 0) break;
    for (const a of addons) {
      const app = normalise(a, base);
      if (bugBountyOnly && !app.bugBountyParticipant) continue;
      results.push(app);
      if (results.length >= cap) break;
    }
    offset += addons.length;
    await sleep(delayMs);
  }
  return results;
}

module.exports = { searchApps, normalise, bugBountyStatus, sleep };
