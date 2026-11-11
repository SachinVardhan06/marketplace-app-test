'use strict';

// Minimal .env reader: KEY=value lines, # comments, optional quotes. No deps.
// It lives on its own because both the config loader and the Jira client need
// it, and neither should have to require the other to get it.

const fs = require('fs');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

module.exports = { loadDotEnv };
