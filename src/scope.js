'use strict';

// Hosts any tab may navigate to at the top level. Everything else is blocked so
// the session cannot wander onto targets you are not authorised to test
// (other customers' *.atlassian.net sites, vendor production infra, etc.).
const BASE_ALLOWED = [
  'marketplace.atlassian.com',
  'id.atlassian.com',
  'auth.atlassian.com',
  'start.atlassian.com',
  'admin.atlassian.com',
  'developer.atlassian.com',
  'bugcrowd.com',
];

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function buildScope({ testSite, secondTestSite, extraAllowedHosts = [], marketplaceBase }) {
  const allowed = new Set(BASE_ALLOWED);
  const siteHost = testSite ? hostOf(testSite) : null;
  if (siteHost) allowed.add(siteHost);
  const secondHost = secondTestSite ? hostOf(secondTestSite) : null;
  if (secondHost) allowed.add(secondHost);
  const mpHost = marketplaceBase ? hostOf(marketplaceBase) : null;
  if (mpHost) allowed.add(mpHost);
  for (const h of extraAllowedHosts) allowed.add(String(h).toLowerCase());

  function isAllowed(url) {
    if (url.startsWith('about:') || url.startsWith('data:') || url.startsWith('chrome:')) return true;
    const h = hostOf(url);
    if (!h) return false;
    if (allowed.has(h)) return true;
    // Allow subdomains of bugcrowd.com (program pages) only.
    if (h.endsWith('.bugcrowd.com')) return true;
    return false;
  }

  return { isAllowed, allowedHosts: [...allowed], siteHost, siteHosts: [siteHost, secondHost].filter(Boolean) };
}

// Blocks top-level (main frame) navigations that leave scope. Sub-resources and
// app iframes are left alone so pages still render; they are only observed.
async function enforceScope(context, scope, log) {
  await context.route('**/*', async (route) => {
    const req = route.request();
    let isTopNav = false;
    try { isTopNav = req.isNavigationRequest() && req.frame() === req.frame().page().mainFrame(); } catch { isTopNav = req.isNavigationRequest(); }
    if (isTopNav && !scope.isAllowed(req.url())) {
      log(`[scope] BLOCKED out-of-scope navigation: ${req.url()}`);
      return route.abort('blockedbyclient').catch(() => {});
    }
    return route.continue().catch(() => {});
  });
}

module.exports = { buildScope, enforceScope, hostOf };
