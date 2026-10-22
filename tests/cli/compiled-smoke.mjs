/* global console, process */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';

const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
);
const home = mkdtempSync(join(tmpdir(), 'pg-ssh-proxy-cli-'));
const run = (...args) =>
  execFileSync(process.execPath, ['dist/cli/main.js', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    encoding: 'utf8'
  });

if (!run('--help').includes('Run local PostgreSQL endpoints through SSH')) {
  throw new Error('CLI help did not start');
}
if (run('--version').trim() !== version) {
  throw new Error('CLI version does not match package version');
}
if (
  !run('config', 'path').includes(join(home, '.pg-ssh-proxy', 'config.json'))
) {
  throw new Error('CLI did not use the current user home');
}
if (!run('list').includes('No proxies configured')) {
  throw new Error('CLI list did not handle an empty configuration');
}

const configDirectory = join(home, '.pg-ssh-proxy');
mkdirSync(configDirectory, { recursive: true });
writeFileSync(join(configDirectory, 'config.json'), '{"invalid":true}\n');
const invalidConfigResult = spawnSync(
  process.execPath,
  ['dist/cli/main.js', 'config', 'validate'],
  {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    encoding: 'utf8'
  }
);
if (invalidConfigResult.status !== 1) {
  throw new Error('CLI accepted an invalid configuration');
}
const logDirectory = join(configDirectory, 'logs');
const logFile = readdirSync(logDirectory).find(
  (file) => file.startsWith('pg-ssh-proxy-') && file.endsWith('.log')
);
if (!logFile) {
  throw new Error('CLI did not create a diagnostic log');
}
const logEntries = readFileSync(join(logDirectory, logFile), 'utf8')
  .trim()
  .split('\n')
  .map(JSON.parse);
const configFailure = logEntries.at(-1);
if (
  configFailure?.event !== 'runtime' ||
  configFailure?.status !== 'failed' ||
  configFailure?.phase !== 'config' ||
  configFailure?.version !== version
) {
  throw new Error('CLI did not persist safe config diagnostics');
}

console.log('Compiled CLI smoke test passed');
