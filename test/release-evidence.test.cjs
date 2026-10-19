const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sourceHashes, verifySourceHashes, testCounts } = require('../scripts/lib/evidence.cjs');

function workspace(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'ct-cdp-evidence-'));
  t.after(() => {
    const target = fs.realpathSync(root);
    assert.equal(path.dirname(target), parent);
    assert.ok(path.basename(target).startsWith('ct-cdp-evidence-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  return root;
}

test('CDP evidence rejects missing or changed sources instead of reusing a stale pass', (t) => {
  const root = workspace(t),
    file = path.join(root, 'runtime.js');
  fs.writeFileSync(file, 'our runtime');
  const recorded = sourceHashes(root, ['runtime.js']);
  assert.equal(verifySourceHashes(root, recorded), true);
  assert.throws(() => verifySourceHashes(root, {}, ['runtime.js']), /stale-source-evidence/);
  assert.throws(() => verifySourceHashes(root, null), /missing-source-evidence/);
  fs.appendFileSync(file, 'changed');
  assert.throws(() => verifySourceHashes(root, recorded), /stale-source-evidence/);
});

test('CDP release gate accepts only one complete, nonempty all-passing TAP summary', () => {
  const tap = (tests = 2, pass = tests, fail = 0, skip = 0) =>
    `# tests ${tests}\n# pass ${pass}\n# fail ${fail}\n# cancelled 0\n# skipped ${skip}\n# todo 0\n`;
  assert.equal(testCounts(tap()).pass, 2);
  for (const text of [tap(0), tap(2, 1, 1), tap(2, 1, 0, 1), tap() + tap(), '']) {
    assert.throws(() => testCounts(text), /node-tests-not-all-passed|invalid-node-test-summary/);
  }
});
