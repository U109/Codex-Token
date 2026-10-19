'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// 构建和验收共享摘要算法；由调用方显式列出来源，避免维护第二份模块清单。
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceHashes = (root, files) =>
  Object.fromEntries(files.map((file) => [file, hash(path.join(root, file))]));

/** 校验本次构建记录的全部来源，拒绝沿用源码已变化的构建结果。 */
function verifySourceHashes(root, recorded, required = Object.keys(recorded ?? {})) {
  if (!recorded || required.length === 0) throw new Error('missing-source-evidence');
  for (const file of required) {
    if (!recorded[file] || hash(path.join(root, file)) !== recorded[file])
      throw new Error('stale-source-evidence');
  }
  return true;
}

/** 仅接受完整、非空且全部通过的单次 TAP 汇总，失败/跳过均不能作为发布通过。 */
function testCounts(tap) {
  const counts = {};
  for (const name of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const found = [...tap.matchAll(new RegExp('^# ' + name + ' (\\d+)\\s*$', 'gm'))];
    if (found.length !== 1) throw new Error('invalid-node-test-summary');
    counts[name] = Number(found[0][1]);
  }
  if (
    counts.tests === 0 ||
    counts.pass !== counts.tests ||
    ['fail', 'cancelled', 'skipped', 'todo'].some((key) => counts[key] !== 0)
  ) {
    throw new Error('node-tests-not-all-passed');
  }
  return counts;
}

module.exports = { hash, sourceHashes, verifySourceHashes, testCounts };
