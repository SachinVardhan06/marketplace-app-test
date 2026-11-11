'use strict';

const fs = require('fs');
const path = require('path');
const { loadDotEnv } = require('./dotenv');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASE = 'https://marketplace.atlassian.com';

const DEFAULTS = {
  testSite: null,
  secondTestSite: null,
  query: '',
  hosting: 'cloud',
  maxApps: 25,
  bugBountyOnly: true,
  delayMs: 2000,
  openListingsInTab: true,
  extraAllowedHosts: [],
  retries: 5,
  navTimeoutMs: 45000,
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function readConfigFile(file, warn) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    warn(`[config] could not parse ${file} (${e.message}); using defaults`);
    return {};
  }
}

function num(value, fallback, { min = -Infinity, max = Infinity } = {}, name, warn) {
  const n = Number(value);
  if (value === undefined || value === null || value === '') return fallback;
  if (!Number.isFinite(n)) { warn(`[config] ${name}="${value}" is not a number; using ${fallback}`); return fallback; }
  return Math.min(max, Math.max(min, n));
}

// Which of the two test accounts this run belongs to. Only A and B exist: the
// baseline, the comparison and the credentials in .env all use those labels.
function accountLabel(value, warn) {
  if (value === undefined || value === null || value === '' || value === true) return null;
  const label = String(value).trim().toUpperCase();
  if (label === 'A' || label === 'B') return label;
  warn(`[config] --account must be A or B (got "${value}"); ignoring it and using the shared profile`);
  return null;
}

function validSite(url, warn) {
  if (!url || /YOUR-OWN-(SECOND-)?TEST-SITE/i.test(url)) return null;
  let u;
  try { u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`); } catch {
    warn(`[config] testSite "${url}" is not a valid URL; tab 2 will stay blank`);
    return null;
  }
  if (u.hostname === 'marketplace.atlassian.com') {
    warn('[config] testSite must be your own site, not the Marketplace; tab 2 will stay blank');
    return null;
  }
  return u.toString();
}

function loadConfig(argv, warn = console.warn) {
  const args = parseArgs(argv);
  const file = args.config ? path.resolve(String(args.config)) : path.join(ROOT, 'config.json');
  const cfg = { ...DEFAULTS, ...readConfigFile(file, warn) };

  // The site may also come from .env (HUNT_SITE / HUNT_SECOND_SITE), beside the
  // credentials. config.json wins, then the flag; this is only a fallback so a
  // site typed in the one file the researcher already edits is not ignored.
  const envCfg = { ...loadDotEnv(path.join(ROOT, '.env')), ...process.env };
  if (!cfg.testSite && envCfg.HUNT_SITE) cfg.testSite = String(envCfg.HUNT_SITE);
  if (!cfg.secondTestSite && envCfg.HUNT_SECOND_SITE) cfg.secondTestSite = String(envCfg.HUNT_SECOND_SITE);

  if (args.site) cfg.testSite = String(args.site);
  if (args['second-site']) cfg.secondTestSite = String(args['second-site']);
  if (args.query) cfg.query = String(args.query);
  if (args.max !== undefined) cfg.maxApps = args.max;
  if (args.delay !== undefined) cfg.delayMs = args.delay;
  if (args.retries !== undefined) cfg.retries = args.retries;
  if (args.all) cfg.bugBountyOnly = false;
  if (args['no-listings']) cfg.openListingsInTab = false;

  cfg.marketplaceBase = String(args['marketplace-base'] || DEFAULT_BASE).replace(/\/+$/, '');
  const real = cfg.marketplaceBase === DEFAULT_BASE;

  cfg.testSite = validSite(cfg.testSite, warn);
  cfg.secondTestSite = validSite(cfg.secondTestSite, warn);
  cfg.maxApps = num(cfg.maxApps, DEFAULTS.maxApps, { min: 1, max: 200 }, 'maxApps', warn);
  // Never go faster than one request per second against the real Marketplace.
  cfg.delayMs = num(cfg.delayMs, DEFAULTS.delayMs, { min: real ? 1000 : 0, max: 60000 }, 'delayMs', warn);
  cfg.retries = num(cfg.retries, DEFAULTS.retries, { min: 0, max: 10 }, 'retries', warn);
  cfg.navTimeoutMs = num(cfg.navTimeoutMs, DEFAULTS.navTimeoutMs, { min: 5000, max: 180000 }, 'navTimeoutMs', warn);
  if (!Array.isArray(cfg.extraAllowedHosts)) cfg.extraAllowedHosts = [];
  cfg.bugBountyOnly = cfg.bugBountyOnly !== false;
  cfg.openListingsInTab = cfg.openListingsInTab !== false;

  cfg.headless = Boolean(args.headless);
  cfg.resume = Boolean(args.resume);
  cfg.help = Boolean(args.help);
  cfg.outDir = path.resolve(String(args.out || path.join(ROOT, 'output')));

  // --account A|B keeps the two test logins in separate browser profiles. Signing
  // both into one profile is the classic way to fake a permission bypass: the
  // second login silently replaces the first, so "account B saw it" really means
  // account A saw it. Separate profiles make that impossible.
  cfg.account = accountLabel(args.account, warn);
  const defaultProfile = cfg.account ? path.join(ROOT, `.profile-${cfg.account}`) : path.join(ROOT, '.profile');
  cfg.profileDir = path.resolve(String(args.profile || defaultProfile));
  return cfg;
}

module.exports = { loadConfig, parseArgs, DEFAULTS, DEFAULT_BASE, ROOT };
