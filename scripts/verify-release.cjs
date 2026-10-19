'use strict';
// 验收当前构建的载荷、来源和回归结果。界面及正式宿主兼容性需要另外人工核对。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hash, sourceHashes, verifySourceHashes, testCounts } = require('./lib/evidence.cjs');
const { powershellEnvironment } = require('./lib/powershell.cjs');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, '.artifacts');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

function main() {
  assert.equal(process.platform, 'win32', 'Windows is required to verify the installer.');
  fs.mkdirSync(artifacts, { recursive: true });
  const reportFile = path.join(artifacts, 'release-report.json');
  fs.writeFileSync(
    reportFile,
    JSON.stringify({ passed: false, status: 'running-or-failed' }) + '\n',
  );
  const build = read(path.join(root, 'dist/build-report.json'));
  assert.equal(build.releaseVersion, read(path.join(root, 'package.json')).version);
  verifySourceHashes(root, build.sourceSha256);
  assert.equal(hash(build.installer), build.installerSha256);
  assert.equal(
    fs.readFileSync(build.installer + '.sha256', 'utf8').trim(),
    build.installerSha256 + '  ' + path.basename(build.installer),
  );
  const manifest = read(path.join(build.payloadRoot, 'manifest.json'));
  assert.equal(manifest.releaseVersion, build.releaseVersion);
  assert.equal(manifest.applicationId, 'org.codextoken.cdp');
  assert.equal(manifest.schemaVersion, 6);
  assert.equal(manifest.compatibilityMode, 'auto');
  const expected = [
    'CodexToken.Runtime.exe',
    'CodexToken.ico',
    'LICENSE.txt',
    'Manage.ps1',
    'README.txt',
    'runtime.js',
  ];
  assert.deepEqual(Object.keys(manifest.payloadFiles).sort(), expected.sort());
  for (const [name, digest] of Object.entries(manifest.payloadFiles)) {
    assert.equal(path.basename(name), name, 'Payload entries must be flat filenames.');
    assert.equal(hash(path.join(build.payloadRoot, name)), digest);
  }
  assert.equal(hash(path.join(build.payloadRoot, 'LICENSE.txt')), hash(path.join(root, 'LICENSE')));
  const runtime = path.join(build.payloadRoot, 'runtime.js');
  let result = spawnSync(process.execPath, ['--check', runtime], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);

  // 对最终两个可执行文件进行原生图标提取；不会运行安装或启动 Codex。
  const env = powershellEnvironment();
  result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(__dirname, 'verify-icon.ps1'),
    ],
    { cwd: root, encoding: 'utf8', windowsHide: true, env },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const tests = fs
    .readdirSync(path.join(root, 'test'))
    .filter((name) => name.endsWith('.test.cjs'))
    .sort()
    .map((name) => 'test/' + name);
  result = spawnSync(process.execPath, ['--test', ...tests], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 8 * 1024 * 1024,
  });
  fs.writeFileSync(
    path.join(artifacts, 'node-tests.tap'),
    (result.stdout || '') + (result.stderr || ''),
  );
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  const counts = testCounts(result.stdout);
  const report = {
    checkedAt: new Date().toISOString(),
    passed: true,
    releaseVersion: build.releaseVersion,
    installerSha256: build.installerSha256,
    nodeTests: counts,
    testSourceSha256: sourceHashes(root, tests),
    payloadIntegrityVerified: true,
    sourceIntegrityVerified: true,
    embeddedIconsVerified: true,
    formalHostAcceptance: false,
    realModelRequests: 0,
  };
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(
    `Release ${build.releaseVersion}: payload, source hashes, 10 icon sizes, and ${counts.pass} tests passed.`,
  );
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
