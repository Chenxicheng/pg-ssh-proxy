import { constants } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

const nameSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must use lowercase kebab-case');
const portSchema = z.number().int().min(1).max(65_535);
const nonEmptySchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) =>
      [...value].every((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code > 31 && !(code >= 127 && code <= 159);
      }),
    'must not contain control characters'
  );

const authenticationSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('agent') }),
  z.strictObject({
    type: z.literal('identityFile'),
    path: nonEmptySchema
  }),
  z.strictObject({ type: z.literal('password') })
]);

const sshHostSchema = z.strictObject({
  host: nonEmptySchema,
  port: portSchema,
  username: nonEmptySchema,
  authentication: authenticationSchema
});

const proxySchema = z.strictObject({
  localPort: portSchema,
  sshHost: nameSchema,
  target: z.strictObject({
    host: nonEmptySchema,
    port: portSchema
  })
});

const configSchema = z.strictObject({
  sshHosts: z.record(nameSchema, sshHostSchema),
  proxies: z.record(nameSchema, proxySchema)
});

export type Config = z.infer<typeof configSchema>;
export type Authentication = z.infer<typeof authenticationSchema>;
export type SshHostConfig = z.infer<typeof sshHostSchema>;
export type ProxyConfig = z.infer<typeof proxySchema>;

export class ConfigValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(
      `Invalid configuration:\n${issues.map((issue) => `- ${issue}`).join('\n')}`
    );
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

const secretKeys = new Set(['password', 'passphrase', 'privatekey']);

function collectSecretFields(
  value: unknown,
  path: Array<string | number> = [],
  issues: string[] = []
): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectSecretFields(item, [...path, index], issues)
    );
    return issues;
  }
  if (value === null || typeof value !== 'object') {
    return issues;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (secretKeys.has(key.toLowerCase())) {
      issues.push(
        `${childPath.join('.')} must not be stored; enter secrets interactively`
      );
    }
    collectSecretFields(child, childPath, issues);
  }
  return issues;
}

function collectBusinessIssues(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  const root = value as Record<string, unknown>;
  const sshHosts =
    root.sshHosts !== null &&
    typeof root.sshHosts === 'object' &&
    !Array.isArray(root.sshHosts)
      ? (root.sshHosts as Record<string, unknown>)
      : {};
  const proxies =
    root.proxies !== null &&
    typeof root.proxies === 'object' &&
    !Array.isArray(root.proxies)
      ? (root.proxies as Record<string, unknown>)
      : {};
  const issues: string[] = [];
  const usedPorts = new Map<number, string>();

  for (const [name, candidate] of Object.entries(proxies)) {
    if (candidate === null || typeof candidate !== 'object') {
      continue;
    }
    const proxy = candidate as Record<string, unknown>;
    if (
      typeof proxy.sshHost === 'string' &&
      !Object.hasOwn(sshHosts, proxy.sshHost)
    ) {
      issues.push(
        `proxies.${name}.sshHost references missing SSH host "${proxy.sshHost}"`
      );
    }
    if (typeof proxy.localPort === 'number') {
      const owner = usedPorts.get(proxy.localPort);
      if (owner) {
        issues.push(
          `proxies.${name}.localPort duplicates proxies.${owner}.localPort (${proxy.localPort})`
        );
      } else {
        usedPorts.set(proxy.localPort, name);
      }
    }
  }
  return issues;
}

export function validateConfig(input: unknown): Config {
  const issues = [
    ...collectSecretFields(input),
    ...collectBusinessIssues(input)
  ];
  const result = configSchema.safeParse(input);
  if (!result.success) {
    issues.push(
      ...result.error.issues.map((issue) => {
        const path = issue.path.join('.');
        return `${path || 'config'}: ${issue.message}`;
      })
    );
  }
  if (issues.length > 0 || !result.success) {
    throw new ConfigValidationError([...new Set(issues)]);
  }
  return result.data;
}

function resolveIdentityPath(path: string, userHome: string): string {
  if (path.startsWith('~/')) {
    return join(userHome, path.slice(2));
  }
  if (!isAbsolute(path)) {
    throw new ConfigValidationError([
      'authentication.path must be absolute or start with ~/'
    ]);
  }
  return path;
}

async function collectIdentityIssues(
  input: unknown,
  userHome: string
): Promise<string[]> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return [];
  }
  const root = input as Record<string, unknown>;
  if (
    root.sshHosts === null ||
    typeof root.sshHosts !== 'object' ||
    Array.isArray(root.sshHosts)
  ) {
    return [];
  }
  const issues: string[] = [];
  for (const [name, candidate] of Object.entries(root.sshHosts)) {
    if (candidate === null || typeof candidate !== 'object') continue;
    const authentication = (candidate as Record<string, unknown>)
      .authentication;
    const authenticationRecord = authentication as Record<string, unknown>;
    if (
      authentication === null ||
      typeof authentication !== 'object' ||
      authenticationRecord.type !== 'identityFile' ||
      typeof authenticationRecord.path !== 'string'
    ) {
      continue;
    }
    const identityPath = authenticationRecord.path;
    let path: string;
    try {
      path = resolveIdentityPath(identityPath, userHome);
    } catch {
      issues.push(
        `sshHosts.${name}.authentication.path must be absolute or start with ~/`
      );
      continue;
    }
    try {
      const file = await stat(path);
      await access(path, constants.R_OK);
      if (!file.isFile()) {
        issues.push(
          `sshHosts.${name}.authentication.path is not a regular file: ${path}`
        );
      }
    } catch {
      issues.push(
        `sshHosts.${name}.authentication.path is not a readable file: ${path}`
      );
    }
  }
  return issues;
}

export async function loadConfig(
  configPath: string,
  userHome = homedir()
): Promise<Config> {
  let input: unknown;
  try {
    input = JSON.parse(await readFile(configPath, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ConfigValidationError([`config.json: ${error.message}`]);
    }
    throw error;
  }
  let config: Config | undefined;
  let issues: string[] = [];
  try {
    config = validateConfig(input);
  } catch (error) {
    if (!(error instanceof ConfigValidationError)) throw error;
    issues = error.issues;
  }
  issues.push(...(await collectIdentityIssues(input, userHome)));
  if (issues.length > 0 || !config) {
    throw new ConfigValidationError([...new Set(issues)]);
  }

  for (const sshHost of Object.values(config.sshHosts)) {
    if (sshHost.authentication.type !== 'identityFile') {
      continue;
    }
    const path = resolveIdentityPath(sshHost.authentication.path, userHome);
    sshHost.authentication.path = path;
  }
  return config;
}

export async function saveConfig(
  input: unknown,
  configPath: string,
  userHome = homedir()
): Promise<void> {
  const config = validateConfig(input);
  const identityIssues = await collectIdentityIssues(config, userHome);
  if (identityIssues.length > 0) {
    throw new ConfigValidationError(identityIssues);
  }
  const directory = dirname(configPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await chmod(directory, 0o700);
  }

  const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
  try {
    const file = await open(temporaryPath, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, configPath);
    if (process.platform !== 'win32') {
      await chmod(configPath, 0o600);
    }
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}
