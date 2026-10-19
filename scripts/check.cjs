'use strict';
// 无需安装依赖即可检查源码语法和本地模块引用；不会启动宿主或访问用户档案。
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { powershellEnvironment } = require('./lib/powershell.cjs');

const root = path.resolve(__dirname, '..');
function filesIn(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__pycache__' || entry.isSymbolicLink()) return [];
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(file) : [file];
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(result.error?.message || result.stderr || result.stdout);
}

function main() {
  const files = ['src', 'scripts', 'test', 'packaging'].flatMap((folder) =>
    filesIn(path.join(root, folder)),
  );
  const javascript = files.filter((file) => /\.(?:mjs|cjs)$/.test(file));
  for (const file of javascript) {
    run(process.execPath, ['--check', file]);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*['"](\.[^'"]+)['"]/g,
    )) {
      if (
        !fs
          .statSync(path.resolve(path.dirname(file), match[1]), { throwIfNoEntry: false })
          ?.isFile()
      ) {
        throw new Error('Missing local module in ' + path.relative(root, file) + ': ' + match[1]);
      }
    }
  }
  const python = files.filter((file) => file.endsWith('.py'));
  run('python', [
    '-c',
    'import ast, pathlib, sys; [ast.parse(pathlib.Path(p).read_text("utf-8"), filename=p) for p in sys.argv[1:]]',
    ...python,
  ]);
  // Windows PowerShell 5.1 与安装器实际使用的解析器一致。非 Windows CI 仍检查 JS/Python。
  const powershell = files.filter((file) => file.endsWith('.ps1'));
  if (process.platform === 'win32') {
    const env = powershellEnvironment({ CT_CHECK_PS: JSON.stringify(powershell) });
    run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$ErrorActionPreference="Stop"; foreach($file in ($env:CT_CHECK_PS | ConvertFrom-Json)) { $tokens=$null; $errors=$null; $null=[Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors); if($errors.Count) { throw ($errors | Out-String) } }',
      ],
      { env },
    );
  }
  console.log(
    `Checked ${javascript.length} JavaScript modules, ${python.length} Python files` +
      (process.platform === 'win32' ? `, and ${powershell.length} PowerShell scripts.` : '.'),
  );
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
