'use strict';
const http = require('http');

const ADDONS = [
  { key: 'com.example.bounty-app', name: 'Bounty App', summary: 'In program', hosting: 'cloud',
    programs: { bugBountyParticipant: { cloud: { status: 'approved' } } },
    _links: { alternate: { href: '/apps/1/bounty-app' } },
    _embedded: { vendor: { name: 'Example Vendor' }, distribution: { totalInstalls: 1200 }, reviews: { averageStars: 3.8 } } },
  { key: 'com.example.plain-app', name: 'Plain App', summary: 'Not in program', hosting: 'cloud',
    _links: { alternate: { href: '/apps/2/plain-app' } },
    _embedded: { vendor: { name: 'Other, Inc' }, distribution: { totalInstalls: 50 }, reviews: { averageStars: 4.5 } } },
  null,
  { name: 'No key app' },
];

// A fake "own test site" page with an app that talks to a vendor backend on
// another host (localhost vs 127.0.0.1), so the lead finder has traffic to sort.
function sitePage(port) {
  const vendor = `http://localhost:${port}`;
  return `<html><body><h1>my site</h1><script>
    (async () => {
      await fetch('${vendor}/api/v1/projects/12345/export?url=http://example.org/feed&file=report.pdf&cloudId=abc-123&sort=name');
      await fetch('${vendor}/api/echo?q=marker1234');
      await fetch('${vendor}/api/settings', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'title=hello+world&template=main' });
      await fetch('${vendor}/api/import', { method: 'POST', headers: { 'content-type': 'application/xml' }, body: '<?xml version="1.0"?><a>1</a>' });
      // App iframe that changes state using only the site cookie (CSRF lead).
      document.cookie = 'sess=1; path=/';
      const f = document.createElement('iframe');
      f.src = '/app-frame';
      document.body.appendChild(f);
    })();
  </script></body></html>`;
}

function start({ failFirst = 0, rateLimitFirst = 0, apiDown = false } = {}) {
  let apiHits = 0;
  const stats = { apiHits: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const port = server.address().port;
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', '*');
    if (req.method === 'OPTIONS') return res.end();

    if (url.pathname === '/rest/2/addons') {
      apiHits++; stats.apiHits = apiHits;
      if (apiDown) { res.statusCode = 503; return res.end('down'); }
      if (apiHits <= rateLimitFirst) { res.statusCode = 429; res.setHeader('retry-after', '0'); return res.end('slow down'); }
      if (apiHits <= rateLimitFirst + failFirst) { res.statusCode = 500; return res.end('oops'); }
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 50);
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ count: ADDONS.length, _embedded: { addons: ADDONS.slice(offset, offset + limit) } }));
    }
    if (url.pathname === '/search') {
      res.setHeader('content-type', 'text/html');
      return res.end('<a href="/apps/1/bounty-app">Bounty App</a><a href="/apps/2/plain-app">Plain App</a><a href="/about">x</a>');
    }
    if (url.pathname === '/my-site') {
      res.setHeader('content-type', 'text/html');
      return res.end(sitePage(port));
    }
    if (url.pathname === '/app-frame') {
      res.setHeader('content-type', 'text/html');
      return res.end(`<script>fetch('/api/prefs', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'theme=dark' });</script>`);
    }
    if (url.pathname.startsWith('/api/')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      return req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, echo: url.searchParams.get('q') }));
      });
    }
    res.setHeader('content-type', 'text/html');
    res.end(`<html><body><h1>${url.pathname}</h1></body></html>`);
  });
  return new Promise((r) => server.listen(0, () => { server.stats = stats; r(server); }));
}

module.exports = { start, ADDONS };
