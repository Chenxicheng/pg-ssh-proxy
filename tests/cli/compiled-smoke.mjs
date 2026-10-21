/* global console, process */

import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
if (run('--version').trim() !== '1.0.0') {
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

console.log('Compiled CLI smoke test passed');
