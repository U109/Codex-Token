'use strict';
// 本机可选烟测入口：固定子进程环境，并核对报告属于当前载荷和当前验证脚本。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hash, verifySourceHashes } = require('./lib/evidence.cjs');
const { powershellEnvironment } = require('./lib/powershell.cjs');
const root = path.resolve(__dirname, '..');

try {
  assert.equal(process.platform, 'win32', 'Windows is required for the installation smoke test.');
  const build = JSON.parse(fs.readFileSync(path.join(root, 'dist/build-report.json'), 'utf8'));
  verifySourceHashes(root, build.sourceSha256);
  assert.equal(hash(build.installer), build.installerSha256);
  const script = path.join(__dirname, 'verify-install.ps1');
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    {
      cwd: root,
      env: powershellEnvironment(),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120000,
    },
  );
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  assert.equal(result.stderr.trim(), '', result.stderr);
  const report = JSON.parse(
    fs.readFileSync(path.join(root, '.artifacts/install-smoke-report.json'), 'utf8'),
  );
  assert.equal(report.passed, true);
  assert.equal(report.installerSha256, build.installerSha256);
  assert.equal(report.verifierSha256, hash(script));
  assert.equal(report.ownedAutomaticUpgradePassed, true);
  assert.equal(report.installedFilesMatchFinalPayload, true);
  assert.equal(report.ownedUninstallPassed, true);
  assert.equal(report.officialFilesUnchanged, true);
  console.log(
    'Final payload installation, automatic upgrade, and uninstall passed in the workspace.',
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
