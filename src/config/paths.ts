import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AppPaths {
  root: string;
  config: string;
  knownHosts: string;
  logs: string;
  runtime: string;
}

export function appPaths(userHome = homedir()): AppPaths {
  const root = join(userHome, '.pg-ssh-proxy');
  return {
    root,
    config: join(root, 'config.json'),
    knownHosts: join(root, 'known_hosts'),
    logs: join(root, 'logs'),
    runtime: join(root, 'runtime.json')
  };
}
