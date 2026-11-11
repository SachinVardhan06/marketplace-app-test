'use strict';

// Tools the agent can call. They are safe by construction: browsing and clicking
// only ever act on the researcher's own test sites, and the agent cannot send a
// test payload to an app itself. For actual vulnerability testing it writes a
// manual test plan that the researcher runs by hand. Every tool enforces scope,
// so a confused or manipulated model still cannot reach anything out of scope.

const fs = require('fs');
const path = require('path');
const { hostOf } = require('../scope');
const leadFinder = require('../analyze');

const MAX_OUT = 6000;
const clip = (s, n = MAX_OUT) => (s.length > n ? `${s.slice(0, n)}\n...[truncated ${s.length - n} chars]` : s);
const json = (v) => clip(JSON.stringify(v, null, 1));

const TOOL_DEFS = [
  {
    name: 'list_leads',
    description: 'Re-run the lead finder on all traffic captured from the test sites and return leads, optionally for one focus area. Areas: crossInstance, accessControl, ssrf, xss, csrf, sqli, xxe, rce, traversal.',
    input_schema: { type: 'object', properties: { area: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'get_traffic',
    description: 'Search captured requests from the test sites. Filter by a substring of the URL and/or HTTP method. Returns the newest matches first, with params, headers (redacted) and the start of any body.',
    input_schema: {
      type: 'object',
      properties: { contains: { type: 'string' }, method: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 30 } },
      additionalProperties: false,
    },
  },
  {
    name: 'browse',
    description: "Open a URL on one of the researcher's own test sites in the target tab and return the page (title, visible text, links, forms, app iframes). Only the researcher's own sites are allowed.",
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false },
  },
  {
    name: 'read_page',
    description: 'Return the current target-tab page again (title, visible text, links, forms, app iframes) without navigating.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'click',
    description: "Click an element in the target tab (or inside an app iframe) by CSS selector or visible text to open an app feature, then return the updated page. Navigation only — use it to make the app do its normal work so more traffic is captured. Acts only on the researcher's own sites.",
    input_schema: {
      type: 'object',
      properties: { selector: { type: 'string' }, text: { type: 'string' }, frameUrlContains: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'write_test_plan',
    description: 'Record a precise, safe, manual test for the researcher to run themselves on their own site. Use for any check that would send data to an app. You never execute it.',
    input_schema: {
      type: 'object',
      properties: {
        area: { type: 'string' },
        hypothesis: { type: 'string' },
        app: { type: 'string' },
        endpoint: { type: 'string' },
        steps: { type: 'string', description: 'Exact manual steps: the single request or UI action and the one harmless marker or benign check to use.' },
        positiveResult: { type: 'string', description: 'What the researcher should see if the issue is real.' },
        safetyNote: { type: 'string', description: 'Why this stays within program rules (own site, stops at proof, no data exfiltration).' },
      },
      required: ['area', 'hypothesis', 'endpoint', 'steps', 'positiveResult'],
      additionalProperties: false,
    },
  },
  {
    name: 'draft_report',
    description: 'Write up a confirmed issue as a Bugcrowd-style report draft. Only after the researcher confirms a test plan reproduced the bug.',
    input_schema: {
      type: 'object',
      properties: {
        area: { type: 'string' },
        title: { type: 'string' },
        severity: { type: 'string', enum: ['P1', 'P2', 'P3', 'P4', 'P5'] },
        app: { type: 'string' },
        endpoint: { type: 'string' },
        steps: { type: 'string' },
        evidence: { type: 'string' },
        impact: { type: 'string' },
        remediation: { type: 'string' },
      },
      required: ['area', 'title', 'severity', 'endpoint', 'steps', 'evidence', 'impact'],
      additionalProperties: false,
    },
  },
  {
    name: 'ask_researcher',
    description: 'Ask the researcher a question (e.g. to sign in, install an app, or confirm scope) and wait for their answer.',
    input_schema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'], additionalProperties: false },
  },
];

function createTools(env) {
  const { tabs, scope, trafficFile, outDir, log, ask } = env;
  const ownHosts = new Set(scope.siteHosts);
  const state = { plans: [], reports: [] };

  const readTraffic = () => (fs.existsSync(trafficFile) ? leadFinder.readTraffic(trafficFile) : []);

  function assertOwnSite(url) {
    const h = hostOf(url);
    if (!h || !ownHosts.has(h)) {
      throw new Error(`out of scope: ${h || url} is not one of your test sites (${[...ownHosts].join(', ') || 'none configured'})`);
    }
  }

  async function frameFor(page, frameUrlContains) {
    if (!frameUrlContains) return page.mainFrame();
    const f = page.frames().find((fr) => fr.url().includes(frameUrlContains));
    if (!f) throw new Error(`no frame with URL containing "${frameUrlContains}"`);
    return f;
  }

  async function snapshot(page) {
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    const snap = await page.evaluate(() => ({
      title: document.title,
      url: location.href,
      text: (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').slice(0, 3000),
      links: [...document.querySelectorAll('a[href]')].slice(0, 60).map((a) => ({ text: a.innerText.trim().slice(0, 60), href: a.href })),
      forms: [...document.querySelectorAll('form, input, textarea, select, button')].slice(0, 40).map((el) => ({
        tag: el.tagName.toLowerCase(), name: el.getAttribute('name'), id: el.id || null, type: el.getAttribute('type'),
        label: (el.innerText || el.value || el.getAttribute('placeholder') || '').trim().slice(0, 40),
      })),
    })).catch((e) => ({ error: e.message }));
    snap.appIframes = page.frames().filter((f) => f !== page.mainFrame()).map((f) => f.url())
      .filter((u) => u && u !== 'about:blank').slice(0, 15);
    return json(snap);
  }

  function saveArtifact(kind, record) {
    const list = kind === 'report' ? state.reports : state.plans;
    list.push(record);
    const file = path.join(outDir, `${kind === 'report' ? 'reports' : 'test-plans'}.json`);
    try { fs.writeFileSync(file, JSON.stringify(list, null, 2)); } catch (e) { log(`[agent] could not save ${kind}: ${e.message}`); }
    return file;
  }

  const handlers = {
    async list_leads({ area }) {
      if (!fs.existsSync(trafficFile)) return 'No traffic captured yet. Browse and click around the test site first.';
      const leads = leadFinder.analyze(readTraffic());
      if (area) {
        if (!leads[area]) throw new Error(`unknown area "${area}"`);
        return json(leads[area].slice(0, 25));
      }
      return json(Object.fromEntries(Object.entries(leads).map(([k, v]) => [k, v.slice(0, 6)])));
    },

    async get_traffic({ contains, method, limit = 10 }) {
      const rows = readTraffic()
        .filter((e) => (!contains || (e.url && e.url.includes(contains))) && (!method || e.method === method.toUpperCase()))
        .slice(-limit).reverse()
        .map((e) => ({ method: e.method, url: e.url, host: e.host, status: e.status, type: e.type, thirdParty: e.thirdParty, params: e.params, reflectedParams: e.reflectedParams, cors: e.cors, postData: e.postData ? e.postData.slice(0, 800) : null }));
      return rows.length ? json(rows) : 'No matching requests.';
    },

    async browse({ url }) {
      assertOwnSite(url);
      await tabs.goto('target', url);
      return snapshot(await tabs.page('target'));
    },

    async read_page() {
      return snapshot(await tabs.page('target'));
    },

    async click({ selector, text, frameUrlContains }) {
      if (!selector && !text) throw new Error('give a selector or visible text');
      const page = await tabs.page('target');
      assertOwnSite(page.url());
      const frame = await frameFor(page, frameUrlContains);
      const loc = selector ? frame.locator(selector).first() : frame.getByText(text, { exact: false }).first();
      await loc.click({ timeout: 10000 });
      return snapshot(page);
    },

    async write_test_plan(input) {
      const record = { ...input, createdAt: new Date().toISOString() };
      const file = saveArtifact('plan', record);
      log(`[agent] test plan (${input.area}): ${input.hypothesis || input.endpoint}`);
      return `Saved test plan #${state.plans.length} for ${input.area} to ${path.basename(file)}. Run it yourself; tell me the result.`;
    },

    async draft_report(input) {
      const record = { ...input, createdAt: new Date().toISOString() };
      const file = saveArtifact('report', record);
      log(`[agent] report drafted (${input.severity}): ${input.title}`);
      return `Saved report draft #${state.reports.length} (${input.severity}) to ${path.basename(file)}.`;
    },

    async ask_researcher({ question }) {
      log(`[agent] asks: ${question}`);
      const answer = await ask(question);
      return answer || '(no answer; continue with what you can do safely, or stop and summarise)';
    },
  };

  async function run(name, input) {
    const fn = handlers[name];
    if (!fn) return { ok: false, content: `unknown tool ${name}` };
    try {
      return { ok: true, content: await fn(input || {}) };
    } catch (e) {
      log(`[agent] ${name} error: ${e.message}`);
      return { ok: false, content: `Error: ${e.message}` };
    }
  }

  return { defs: TOOL_DEFS, run, state };
}

module.exports = { createTools, TOOL_DEFS };
