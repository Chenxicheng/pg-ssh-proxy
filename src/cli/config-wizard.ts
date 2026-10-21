import { access } from 'node:fs/promises';
import { createServer } from 'node:net';

import { confirm, input, select } from '@inquirer/prompts';

import {
  loadConfig,
  saveConfig,
  type Authentication,
  type Config,
  type ProxyConfig,
  type SshHostConfig
} from '../config/config.js';

export class UserCancelledError extends Error {
  constructor() {
    super('No changes saved');
    this.name = 'UserCancelledError';
  }
}

export async function loadConfigOrEmpty(configPath: string): Promise<Config> {
  try {
    await access(configPath);
    return await loadConfig(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { sshHosts: {}, proxies: {} };
    }
    throw error;
  }
}

function kebab(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'proxy'
  );
}

function required(value: string): true | string {
  return value.trim() ? true : 'Required';
}

function port(value: string): true | string {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 65_535
    ? true
    : 'Enter a port from 1 to 65535';
}

export async function suggestLocalPort(
  usedPorts: Set<number>,
  start = 15_432
): Promise<number> {
  for (let candidate = start; candidate <= 65_535; candidate += 1) {
    if (usedPorts.has(candidate)) continue;
    const available = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once('error', () => resolve(false));
      server.listen(candidate, '127.0.0.1', () => {
        server.close(() => resolve(true));
      });
    });
    if (available) return candidate;
  }
  throw new Error('No available local port found');
}

async function promptAuthentication(
  current?: Authentication
): Promise<Authentication> {
  const type = await select<Authentication['type']>({
    message: 'SSH authentication',
    default: current?.type ?? 'agent',
    choices: [
      { name: 'SSH Agent (recommended)', value: 'agent' },
      { name: 'Private key file', value: 'identityFile' },
      { name: 'Password (entered on every start)', value: 'password' }
    ]
  });
  if (type === 'identityFile') {
    const existing =
      current?.type === 'identityFile' ? current.path : '~/.ssh/id_ed25519';
    return {
      type,
      path: await input({
        message: 'Private key path',
        default: existing,
        validate: required
      })
    };
  }
  return { type };
}

async function promptSshHost(current?: SshHostConfig): Promise<SshHostConfig> {
  return {
    host: await input({
      message: 'SSH host',
      default: current?.host,
      validate: required
    }),
    port: Number(
      await input({
        message: 'SSH port',
        default: String(current?.port ?? 22),
        validate: port
      })
    ),
    username: await input({
      message: 'SSH username',
      default: current?.username,
      validate: required
    }),
    authentication: await promptAuthentication(current?.authentication)
  };
}

async function chooseSshHost(config: Config): Promise<{
  name: string;
  value?: SshHostConfig;
}> {
  const existing = Object.entries(config.sshHosts);
  if (existing.length > 0) {
    const choice = await select<string>({
      message: 'SSH host',
      choices: [
        ...existing.map(([name, host]) => ({
          name: `${name} · ${host.username}@${host.host}:${host.port}`,
          value: name
        })),
        { name: '+ Add a new SSH host', value: '__new__' }
      ]
    });
    if (choice !== '__new__') return { name: choice };
  }

  const value = await promptSshHost();
  const suggested = kebab(value.host.split('.')[0] ?? value.host);
  const name = await input({
    message: 'Name this SSH host',
    default: suggested,
    validate: (candidate) => {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate)) {
        return 'Use lowercase kebab-case';
      }
      return Object.hasOwn(config.sshHosts, candidate)
        ? 'That SSH host name already exists'
        : true;
    }
  });
  return { name, value };
}

async function promptProxy(
  config: Config,
  current?: ProxyConfig
): Promise<ProxyConfig & { newSshHost?: [string, SshHostConfig] }> {
  const targetHost = await input({
    message: 'Database host as seen from the SSH server',
    default: current?.target.host,
    validate: required
  });
  const targetPort = Number(
    await input({
      message: 'Database port',
      default: String(current?.target.port ?? 5432),
      validate: port
    })
  );
  const chosen = await chooseSshHost(config);
  const suggestedPort = await suggestLocalPort(
    new Set(
      Object.values(config.proxies)
        .filter((proxy) => proxy !== current)
        .map((proxy) => proxy.localPort)
    )
  );
  const localPort = Number(
    await input({
      message: 'Local port',
      default: String(current?.localPort ?? suggestedPort),
      validate: (candidate) => {
        const valid = port(candidate);
        if (valid !== true) return valid;
        const owner = Object.entries(config.proxies).find(
          ([, proxy]) =>
            proxy !== current && proxy.localPort === Number(candidate)
        );
        return owner ? `Already used by ${owner[0]}` : true;
      }
    })
  );
  return {
    localPort,
    sshHost: chosen.name,
    target: { host: targetHost, port: targetPort },
    ...(chosen.value ? { newSshHost: [chosen.name, chosen.value] } : {})
  };
}

function printSummary(
  name: string,
  proxy: ProxyConfig,
  sshHost: SshHostConfig
): void {
  console.log('\nConfiguration summary');
  console.log(`  Proxy:    ${name}`);
  console.log(`  Local:    127.0.0.1:${proxy.localPort}`);
  console.log(
    `  SSH:      ${proxy.sshHost} · ${sshHost.username}@${sshHost.host}:${sshHost.port}`
  );
  console.log(`  Database: ${proxy.target.host}:${proxy.target.port}`);
}

export async function addProxy(configPath: string): Promise<Config> {
  const config = await loadConfigOrEmpty(configPath);
  const name = await input({
    message: 'Proxy name',
    default: Object.keys(config.proxies).length === 0 ? 'postgres' : undefined,
    validate: (candidate) => {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate))
        return 'Use lowercase kebab-case';
      return Object.hasOwn(config.proxies, candidate)
        ? 'That proxy name already exists'
        : true;
    }
  });
  const prompted = await promptProxy(config);
  const { newSshHost, ...proxy } = prompted;
  if (newSshHost) config.sshHosts[newSshHost[0]] = newSshHost[1];
  config.proxies[name] = proxy;
  printSummary(name, proxy, config.sshHosts[proxy.sshHost]!);
  if (
    !(await confirm({ message: 'Save this configuration?', default: true }))
  ) {
    throw new UserCancelledError();
  }
  await saveConfig(config, configPath);
  console.log(`\nSaved ${configPath}`);
  return await loadConfig(configPath);
}

export async function editProxy(
  configPath: string,
  requestedName?: string
): Promise<string> {
  const config = await loadConfig(configPath);
  const names = Object.keys(config.proxies);
  if (names.length === 0)
    throw new Error('No proxies configured. Run pg-ssh-proxy add.');
  const name =
    requestedName ??
    (await select({
      message: 'Proxy to edit',
      choices: names.map((value) => ({ value }))
    }));
  const current = config.proxies[name];
  if (!current) throw new Error(`Unknown proxy ${name}`);
  const prompted = await promptProxy(config, current);
  const { newSshHost, ...proxy } = prompted;
  if (newSshHost) config.sshHosts[newSshHost[0]] = newSshHost[1];
  if (
    !newSshHost &&
    (await confirm({
      message: `Edit SSH connection ${proxy.sshHost}?${Object.values(config.proxies).filter((candidate) => candidate.sshHost === proxy.sshHost).length > 1 ? ' This also affects other proxies using it.' : ''}`,
      default: false
    }))
  ) {
    config.sshHosts[proxy.sshHost] = await promptSshHost(
      config.sshHosts[proxy.sshHost]
    );
  }
  config.proxies[name] = proxy;
  printSummary(name, proxy, config.sshHosts[proxy.sshHost]!);
  if (!(await confirm({ message: 'Save these changes?', default: true })))
    throw new UserCancelledError();
  await saveConfig(config, configPath);
  console.log(`\nUpdated ${name}`);
  return name;
}

export async function removeProxy(
  configPath: string,
  requestedName?: string
): Promise<void> {
  const config = await loadConfig(configPath);
  const names = Object.keys(config.proxies);
  if (names.length === 0)
    throw new Error('No proxies configured. Run pg-ssh-proxy add.');
  const name =
    requestedName ??
    (await select({
      message: 'Proxy to remove',
      choices: names.map((value) => ({ value }))
    }));
  const proxy = config.proxies[name];
  if (!proxy) throw new Error(`Unknown proxy ${name}`);
  if (
    !(await confirm({
      message: `Remove ${name} (127.0.0.1:${proxy.localPort})?`,
      default: false
    }))
  )
    throw new UserCancelledError();
  delete config.proxies[name];
  await saveConfig(config, configPath);
  console.log(`Removed ${name}`);
}

export function printConfig(config: Config): void {
  const entries = Object.entries(config.proxies);
  if (entries.length === 0) {
    console.log('No proxies configured. Run pg-ssh-proxy add.');
    return;
  }
  for (const [name, proxy] of entries) {
    const ssh = config.sshHosts[proxy.sshHost]!;
    console.log(
      `${name}\n  127.0.0.1:${proxy.localPort} -> ${proxy.target.host}:${proxy.target.port}\n  via ${proxy.sshHost} (${ssh.username}@${ssh.host}:${ssh.port})`
    );
  }
}
