# Marketplace bug bounty environment

A Playwright script that opens Chrome with two tabs for working on the
Atlassian Marketplace bug bounty:

| Tab | What it does |
| --- | --- |
| 1. Recon | Reads the public Marketplace REST API, keeps apps that take part in the bug bounty, saves them to `output/recon-*.json` / `.csv`, then opens each listing page one by one. |
| 2. Target | Opens **your own** Atlassian Cloud test site. You install and test apps there by hand. Every request from this tab is logged to `output/traffic-*.jsonl` (cookies and auth headers redacted), and `output/hosts-*.json` lists which hosts the apps talked to. |

It does not fuzz, scan, or send payloads. It reads public data and records
traffic you create yourself.

## Setup

```bash
npm install
cp config.example.json config.json   # then set testSite to your own *.atlassian.net site
npm run hunt
```

Get a free test site at https://www.atlassian.com/try (use your own account, for
example one with a bugcrowdninja.com email as the program asks). The browser
profile is kept in `.profile/`, so you only sign in once.

### Options

| Flag | Meaning |
| --- | --- |
| `--site URL` | Your test site (overrides `testSite`) |
| `--query TEXT` | Search text for the Marketplace API |
| `--max N` | Max apps to collect (hard cap 200) |
| `--all` | Keep apps that are not in the bug bounty too |
| `--no-listings` | Don't walk listing pages in tab 1 |
| `--delay MS` | Pause between requests (min 1000 against the real Marketplace) |
| `--headless` | Run without a window and exit after recon |

## Staying in scope

Read the program brief before testing anything:
https://bugcrowd.com/atlassian (and the Marketplace apps program linked from it).

- Test only on sites you own. Never touch other customers' `*.atlassian.net` sites.
- Only apps marked as bug bounty participants are in scope, and only their
  in-scope versions (usually Cloud).
- No automated scanning, DoS, or high-volume traffic. Vendor backends are
  in scope only as the program allows.
- The scope guard in `src/scope.js` blocks top-level navigation to any host that
  is not the Marketplace, Atlassian login/admin pages, Bugcrowd, or your test
  site. Add hosts with `extraAllowedHosts` only after checking the brief.

## Tests

```bash
npm test
```

Runs headless against a local mock Marketplace, so it needs no network.
