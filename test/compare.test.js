'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parsePaths, summarise, verdictFor, countOf, MAX_PATHS } = require('../src/compare');

test('paths must be given exactly, and in small numbers', () => {
  // An exact REST path from captured traffic is fine; flags and duplicates are dropped.
  assert.deepStrictEqual(
    parsePaths(['--headless', '/rest/api/3/project/search', '/rest/api/3/project/search', '/rest/api/3/myself']),
    ['/rest/api/3/project/search', '/rest/api/3/myself'],
  );
  // A guess, a wordlist entry or a non-REST path is refused outright.
  assert.throws(() => parsePaths(['/admin']), /must start with \/rest\//);
  assert.throws(() => parsePaths(['project/search']), /must start with \/rest\//);
  assert.throws(() => parsePaths([]), /at least one path/);
  // And the cap keeps this from becoming an enumeration tool.
  const many = Array.from({ length: MAX_PATHS + 1 }, (_, i) => `/rest/api/3/issue/${i}`);
  assert.throws(() => parsePaths(many), /not an enumeration tool/);
  assert.strictEqual(parsePaths(many.slice(0, MAX_PATHS)).length, MAX_PATHS);
});

test('only the shape of a response is kept, never anyone issue data', () => {
  const s = summarise({
    total: 7,
    issues: [{ id: '1', fields: { summary: 'Acquisition of Contoso' } }],
    key: 'SECRET-1',
  });
  assert.strictEqual(s.type, 'object');
  assert.strictEqual(s.total, 7);
  assert.strictEqual(s.issuesLength, 1);
  assert.strictEqual(s.key, 'SECRET-1');
  assert.ok(!JSON.stringify(s).includes('Contoso'), 'payload text must not be carried into the output file');

  assert.deepStrictEqual(summarise(null), { type: 'empty' });
  assert.deepStrictEqual(summarise([1, 2, 3]), { type: 'array', length: 3 });
  assert.strictEqual(summarise('x').type, 'string');
  // The key list is capped rather than copied wholesale.
  const wide = {};
  for (let i = 0; i < 40; i += 1) wide[`k${i}`] = i;
  assert.strictEqual(summarise(wide).keys.length, 25);

  assert.strictEqual(countOf({ total: 4, valuesLength: 2 }), 4);
  assert.strictEqual(countOf({ length: 9 }), 9);
  assert.strictEqual(countOf({ type: 'object' }), null);
});

test('B getting data where it should get none is what gets flagged', () => {
  const ok = (summary) => ({ ok: true, status: 200, summary });
  const denied = (status) => ({ ok: false, status, summary: null });

  // The finding: both accounts read the same A-only path.
  assert.strictEqual(verdictFor(ok({ total: 7 }), ok({ total: 7 })).verdict, 'REVIEW');
  // No counts to compare, but both succeeded — still worth a look.
  assert.strictEqual(verdictFor(ok({ type: 'object' }), ok({ type: 'object' })).verdict, 'REVIEW');
  // Correct behaviour: B is denied, or sees nothing.
  assert.strictEqual(verdictFor(ok({ total: 7 }), denied(403)).verdict, 'ok');
  assert.strictEqual(verdictFor(ok({ total: 7 }), ok({ total: 0 })).verdict, 'ok');
  assert.strictEqual(verdictFor(denied(404), denied(404)).verdict, 'ok');
  // B sees fewer than A: legitimate for a shared project, so it is only 'partial'.
  assert.strictEqual(verdictFor(ok({ total: 7 }), ok({ total: 3 })).verdict, 'partial');
  // B reading what the admin cannot is odd enough to surface on its own.
  assert.strictEqual(verdictFor(denied(403), ok({ total: 1 })).verdict, 'ODD');
  assert.strictEqual(verdictFor(null, ok({ total: 1 })).verdict, 'incomplete');
});
