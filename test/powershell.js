// Runs Windows PowerShell 5.1 the same way on a developer machine and on a GitHub-hosted runner.
// - Absolute System32 path: a bare "powershell" could resolve to another program on PATH.
// - No PSModulePath: when the parent shell is PowerShell 7 (the runner default), 5.1 would inherit
//   7's module folders and fail to load its own built-in modules (CouldNotAutoLoadModule).
import {spawnSync} from 'node:child_process';
import {existsSync, realpathSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';

export const powershell = process.platform === 'win32'
  ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : null;

export function powershellEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH'));
  return {...env, ...extra};
}

export function runPowerShell(args, options = {}) {
  return spawnSync(powershell, args, {encoding: 'utf8', windowsHide: true, ...options, env: powershellEnv(options.env)});
}

export const hasPowerShell = Boolean(powershell && existsSync(powershell) && runPowerShell(['-NoProfile', '-Command', 'exit 0']).status === 0);

// The spelling the service script prints: existing part in long form (TEMP may be an 8.3 short
// path such as C:\Users\RUNNER~1), missing part appended unchanged.
export function canonicalPath(path) {
  let existing = resolve(path); const rest = [];
  while (!existsSync(existing) && dirname(existing) !== existing) { rest.unshift(basename(existing)); existing = dirname(existing); }
  return join(realpathSync.native(existing), ...rest);
}
