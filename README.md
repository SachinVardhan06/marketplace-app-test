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

## The agent (`npm run agent`)

`npm run agent` launches the two tabs and then hands the wheel to a Claude agent
(`claude-opus-5-5`). The agent:

- browses and clicks through your own test site to exercise the installed apps,
- reads the captured traffic and ranks the leads per focus area,
- writes a precise, safe **manual test plan** for each promising lead
  (`output/test-plans.json`) — the exact request, one harmless marker or benign
  check, and what a positive result looks like,
- drafts Bugcrowd-style reports (`output/reports.json`) for issues you confirm.

The agent explores and proposes; **you run anything that sends data to an app,
and you decide what to report.** By design it has no tool that fires a payload at
an app — that keeps it clear of the "automated scanning" that the program bans,
and keeps the sensitive step in your hands. Its browsing and clicking tools only
ever act on your own sites, enforced in code (`src/agent/tools.js`).

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run agent -- --goal "look at the Confluence macros app" --oob oob.yoursite.example
```

| Flag | Meaning |
| --- | --- |
| `--goal "..."` | What to focus on this run |
| `--oob HOST` | An out-of-band host you own, used only in SSRF/XXE test plans |
| `--turns N` | Max agent turns (default 40) |

Without `ANTHROPIC_API_KEY` the agent step is skipped and the rest of the tool
still works. Set `HUNT_AGENT_MODEL` to use a different model.

## Two test accounts and the permission baseline

The access-control tests all ask the same question: **did the app show this
account something Jira itself would not?** You cannot answer that without
knowing what Jira itself shows, so the tool establishes that first.

Create an API token for each of two accounts on your own test site — one Jira
admin, one deliberately low-privilege — at
https://id.atlassian.com/manage-profile/security/api-tokens, then:

```bash
cp .env.example .env     # fill it in; .env is gitignored
npm run baseline
```

That writes `output/baseline.json`: per site and per account, the account id,
whether it is a Jira admin, which projects it can see, and how many issues it
can see in each. The valuable part is the **control pairs** — projects one
account can see and the other cannot:

```json
{ "projectKey": "SECRET", "visibleTo": "A", "hiddenFrom": "B",
  "issueCountForVisibleAccount": 7, "expectedForHiddenAccount": 0 }
```

That is the assertion to point the app tests at. If the app ever shows account B
data from `SECRET`, the baseline is your evidence that B should have seen
nothing — which is the difference between a finding and a hunch.

`npm run baseline` also reports what is still missing: only one account, no
low-privilege user, both accounts admin, or no project that separates them.

The agent reads this through its `get_baseline` tool and is instructed to
compare against it before calling anything an access-control finding.

### Credential handling

- Tokens are read only from `.env` or the environment — never from
  `config.json`, never from an argument, never committed. `.env` is gitignored.
- They are stripped from anything written to disk (`redactSecrets`).
- The client is **GET-only by construction** — any other method throws, so it
  cannot write to your Jira — and it refuses any host that is not one of your
  configured test sites. Both are enforced in code and covered by tests.
