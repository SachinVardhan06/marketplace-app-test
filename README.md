# Marketplace bug bounty environment

A Playwright tool that opens Chrome with two tabs for working on the Atlassian
Marketplace bug bounty, then sorts what you did into leads for each of the
program's focus areas.

| Tab | What it does |
| --- | --- |
| 1. Recon | Reads the public Marketplace REST API, keeps apps in the bug bounty program, saves them to `output/recon-*.json` / `.csv`, then opens each listing page slowly. |
| 2. Target | Opens **your own** Atlassian Cloud test site. You install and test apps there by hand. Every request from this tab, and from any other tab you open yourself, is logged to `output/traffic-*.jsonl` (cookies, auth headers and tokens redacted). |

When you close the browser (or press Ctrl+C) it writes `output/leads-*.md`:
the app's requests grouped by focus area, each with a short note on how to check
it by hand.

It sends no payloads and does no scanning. It reads public data and records
traffic you create yourself. You do the testing.

## Setup

```bash
npm install
cp config.example.json config.json   # set testSite (and secondTestSite) to your own sites
npm run hunt
```

Get free test sites at https://www.atlassian.com/try with your own account
(the program asks testers to use their bugcrowdninja.com address). The browser
profile is kept in `.profile/`, so you sign in once.

## Focus areas

The lead finder (`src/analyze.js`) looks for these in the app's own traffic
(vendor backend requests and app iframes):

| Area | What it flags |
| --- | --- |
| Cross-instance data access | Vendor requests carrying a tenant id (`cloudId`, `clientKey`, `baseUrl`, ...) or a JWT. Use `secondTestSite` to test site A's data from site B. |
| Access control / IDOR | Numeric or UUID object ids in vendor URLs and params; CORS that allows credentials. |
| SSRF | Parameters whose name or value looks like a URL or host. |
| Stored / reflected XSS | Parameter values reflected in responses; text the vendor stores. |
| CSRF | Cookie-authenticated state changes with no JWT, auth header or anti-CSRF token. |
| SQL injection | id / sort / filter / query style parameters; vendor 5xx responses. |
| XXE | XML request bodies and XML-based uploads (SVG, DOCX, ...). |
| RCE | Template, expression, script parameters; file uploads. |
| Path traversal | File / path / download parameters and path-like values. |

A lead is a place to test, not a finding. Re-run it on any capture with
`npm run leads` (newest capture) or `npm run leads -- output/traffic-....jsonl`.

## Built to keep going

- API calls retry with exponential backoff and honour `Retry-After` on 429.
- If the API stays down, recon falls back to reading the public search page.
- Tabs that crash or get closed reopen at their home page.
- Tries Google Chrome, then Edge, then `CHROME_PATH`, then Playwright Chromium.
  If the saved profile is locked by another browser, uses a temporary one.
- Results are saved after every page (atomic writes), so a crash loses nothing.
  `--resume` continues the last run from where it stopped.
- Ctrl+C, closing the window, or an unexpected error all save results and
  write the leads report before exiting.
- Bad config values fall back to safe defaults with a warning. Everything is
  also logged to `output/run-*.log`.

### Options

| Flag | Meaning |
| --- | --- |
| `--site URL` | Your test site (overrides `testSite`) |
| `--second-site URL` | Your second test site, for cross-instance checks |
| `--query TEXT` | Search text for the Marketplace API |
| `--max N` | Max apps to collect (hard cap 200) |
| `--all` | Keep apps that are not in the bug bounty too |
| `--no-listings` | Don't walk listing pages in tab 1 |
| `--delay MS` | Pause between requests (min 1000 against the real Marketplace) |
| `--retries N` | Retries per request (default 5, max 10) |
| `--resume` | Continue the previous run with the same query |
| `--headless` | Run without a window and exit after recon |

## Staying in scope

Read the program brief before testing anything:
https://bugcrowd.com/atlassian (and the Marketplace apps program linked from it).

- Test only on sites you own. Never touch other customers' `*.atlassian.net` sites.
- Only apps marked as bug bounty participants are in scope, and only their
  in-scope versions. Results from the search-page fallback have unknown status:
  check the listing first.
- No automated scanning, DoS, or high-volume traffic. Stop at proof; never
  pull real data out.
- The scope guard in `src/scope.js` blocks top-level navigation to any host that
  is not the Marketplace, Atlassian login/admin pages, Bugcrowd, or your test
  sites. Add hosts with `extraAllowedHosts` only after checking the brief.

## Tests

```bash
npm test
```

Runs headless against a local mock Marketplace and a mock app backend
(no network needed). Covers rate limiting, server errors, API outage
fallback, resume, tab recovery and the lead finder.
