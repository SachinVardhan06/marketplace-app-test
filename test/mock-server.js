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
];

function start() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/rest/2/addons') {
      const offset = Number(url.searchParams.get('offset') || 0);
      const page = offset === 0 ? ADDONS : [];
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ count: ADDONS.length, _embedded: { addons: page } }));
    }
    res.setHeader('content-type', 'text/html');
    res.end(`<html><body><h1>${url.pathname}</h1></body></html>`);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

module.exports = { start, ADDONS };
