'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { withRetry, sleep } = require('./retry');

const PROFILE_LOCKED = /ProcessSingleton|user data directory is already in use|SingletonLock|profile.*in use/i;

// Tries real Chrome, then Edge, then a custom path, then bundled Chromium.
// If the saved profile is locked (another Chrome using it), uses a temporary one.
async function launchBrowser(cfg, log) {
  const base = {
    headless: cfg.headless,
    viewport: null,
    args: ['--start-maximized', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check'],
    timeout: 60000,
    ignoreHTTPSErrors: false,
    // We handle Ctrl+C ourselves so results are saved before the browser closes.
    handleSIGINT: false,
    handleSIGTERM: false,
  };
  const candidates = [];
  if (process.env.CHROME_PATH) candidates.push({ label: `CHROME_PATH (${process.env.CHROME_PATH})`, executablePath: process.env.CHROME_PATH });
  candidates.push({ label: 'Google Chrome', channel: 'chrome' });
  candidates.push({ label: 'Microsoft Edge', channel: 'msedge' });
  candidates.push({ label: 'Playwright Chromium' });
  if (fs.existsSync('/opt/pw-browsers/chromium')) candidates.push({ label: 'system Chromium', executablePath: '/opt/pw-browsers/chromium' });

  let profileDir = cfg.profileDir;
  fs.mkdirSync(profileDir, { recursive: true });
  const errors = [];
  for (const c of candidates) {
    const { label, ...extra } = c;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const ctx = await chromium.launchPersistentContext(profileDir, { ...base, ...extra });
        log(`[env] launched ${label}${profileDir !== cfg.profileDir ? ' with a temporary profile' : ''}`);
        return ctx;
      } catch (e) {
        const msg = e.message.split('\n')[0];
        if (PROFILE_LOCKED.test(e.message) && profileDir === cfg.profileDir) {
          profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-profile-'));
          log('[env] saved profile is in use by another browser; using a temporary profile (you may need to sign in again)');
          continue;
        }
        errors.push(`${label}: ${msg}`);
        break;
      }
    }
  }
  throw new Error(`Could not start any browser.\n  ${errors.join('\n  ')}\nInstall Google Chrome, or run: npx playwright install chromium`);
}

// Keeps a named tab alive: if it crashes or is closed, it is reopened at its home URL.
class TabManager {
  constructor(context, { log, navTimeoutMs, retries, onNewPage = () => {} }) {
    this.context = context;
    this.log = log;
    this.navTimeoutMs = navTimeoutMs;
    this.retries = retries;
    this.onNewPage = onNewPage;
    this.tabs = new Map(); // name -> { page, home, setup }
    this.stopping = false;
  }

  async open(name, home, { reuse } = {}) {
    let page = reuse && !reuse.isClosed() ? reuse : await this.context.newPage();
    this.tabs.set(name, { page, home });
    this._watch(name, page);
    this.onNewPage(name, page);
    await this.goto(name, home);
    return page;
  }

  _watch(name, page) {
    page.setDefaultNavigationTimeout(this.navTimeoutMs);
    page.setDefaultTimeout(this.navTimeoutMs);
    page.on('crash', () => {
      this.log(`[tabs] ${name} tab crashed, reopening`);
      page.close().catch(() => {});
    });
    page.on('close', () => {
      if (this.stopping || this.contextClosed) return;
      const tab = this.tabs.get(name);
      if (!tab || tab.page !== page) return;
      this.log(`[tabs] ${name} tab was closed, reopening`);
      this._reopen(name).catch((e) => this.log(`[tabs] could not reopen ${name}: ${e.message}`));
    });
  }

  async _reopen(name) {
    const tab = this.tabs.get(name);
    await sleep(500);
    if (this.stopping || this.contextClosed) return null;
    const page = await this.context.newPage();
    tab.page = page;
    this._watch(name, page);
    this.onNewPage(name, page);
    if (tab.home) await this.goto(name, tab.home).catch(() => {});
    return page;
  }

  // Always returns a live page for the tab, reopening it if needed.
  async page(name) {
    const tab = this.tabs.get(name);
    if (!tab) throw new Error(`unknown tab ${name}`);
    if (tab.page.isClosed()) return this._reopen(name);
    return tab.page;
  }

  async goto(name, url) {
    if (!url) return null;
    return withRetry(async () => {
      const page = await this.page(name);
      if (!page) throw new Error('browser is closing');
      if (url.startsWith('about:')) return page.goto(url);
      return page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.navTimeoutMs });
    }, { retries: this.retries, baseMs: 2000, label: `${name} -> ${url}`, log: this.log }).catch((e) => {
      this.log(`[tabs] ${name} could not load ${url}: ${e.message.split('\n')[0]}`);
      return null;
    });
  }
}

module.exports = { launchBrowser, TabManager };
