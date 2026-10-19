'use strict';

/** 子进程使用 Windows PowerShell 自己的模块目录，避免继承 PowerShell 7 的不兼容模块。 */
function powershellEnvironment(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  return env;
}

module.exports = { powershellEnvironment };
