'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function baseArgs(base, extra = []) {
  return ['--headless', '--marketplace-base', base, '--out', tmp('hunt-out-'), '--profile', tmp('hunt-prof-'),
    '--delay', '0', '--config', '/nonexistent.json', ...extra];
}

const outDirOf = (args) => args[args.indexOf('--out') + 1];
const quiet = () => {};

module.exports = { tmp, baseArgs, outDirOf, quiet };
