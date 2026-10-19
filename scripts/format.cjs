'use strict';
// 只处理受维护的源码目录，避免遍历构建产物、历史实验或用户数据。
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { powershellEnvironment } = require('./lib/powershell.cjs');

const root = path.resolve(__dirname, '..');
const check = process.argv.includes('--check');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status}).`);
}

function sources(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink() || entry.name === '__pycache__') return [];
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sources(file) : [file];
  });
}

function main() {
  if (process.argv.slice(2).some((argument) => argument !== '--check')) {
    throw new Error('Usage: node scripts/format.cjs [--check]');
  }
  const tools = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
  const python = path.join(tools, process.platform === 'win32' ? 'python.exe' : 'python');
  if (!fs.existsSync(python)) {
    throw new Error('Install formatting tools in .venv first; see docs/DEVELOPMENT.md.');
  }

  const files = ['scripts', 'packaging', 'test'].flatMap((folder) =>
    sources(path.join(root, folder)),
  );
  const prettier = require.resolve('prettier/bin/prettier.cjs');
  run(process.execPath, [
    prettier,
    check ? '--check' : '--write',
    '*.{md,json}',
    '.prettierrc.json',
    '.csharpierrc.json',
    '.config/**/*.json',
    '.github/**/*.yml',
    'docs/**/*.md',
    'src/**/*.mjs',
    'scripts/**/*.cjs',
    'test/**/*.{cjs,json}',
    'assets/*.svg',
  ]);
  run(python, [
    '-m',
    'black',
    ...(check ? ['--check'] : []),
    ...files.filter((file) => file.endsWith('.py')),
  ]);
  const localDotnet = path.join(
    root,
    '.artifacts/tools/dotnet',
    process.platform === 'win32' ? 'dotnet.exe' : 'dotnet',
  );
  const dotnet = fs.existsSync(localDotnet) ? localDotnet : 'dotnet';
  run(
    dotnet,
    [
      'tool',
      'run',
      'csharpier',
      check ? 'check' : 'format',
      ...files.filter((file) => file.endsWith('.cs')),
    ],
    {
      env: {
        ...process.env,
        ...(fs.existsSync(localDotnet) ? { DOTNET_ROOT: path.dirname(localDotnet) } : {}),
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        DOTNET_NOLOGO: '1',
      },
    },
  );
  if (process.platform === 'win32') {
    run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(__dirname, 'format.ps1'),
        ...(check ? ['-Check'] : []),
      ],
      { env: powershellEnvironment() },
    );
  } else {
    console.log('PowerShell formatting is checked by the Windows CI job.');
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
