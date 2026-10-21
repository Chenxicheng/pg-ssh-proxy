import { readFile } from 'node:fs/promises';

import { confirm, input, password } from '@inquirer/prompts';
import ssh2 from 'ssh2';

const { utils } = ssh2;

import type { Config } from '../config/config.js';
import type {
  ChangedHostKey,
  InteractiveCredentials,
  UnknownHostKey
} from '../proxy/ssh-connection.js';

export function validatePrivateKey(
  key: Buffer,
  passphrase?: string
): Error | undefined {
  const parsed = utils.parseKey(key, passphrase);
  return parsed instanceof Error ? parsed : undefined;
}

export async function promptCredentials(
  config: Config,
  signal?: AbortSignal
): Promise<Map<string, InteractiveCredentials>> {
  const result = new Map<string, InteractiveCredentials>();
  for (const [name, host] of Object.entries(config.sshHosts)) {
    if (host.authentication.type === 'password') {
      result.set(name, {
        password: await password(
          {
            message: `SSH password for ${host.username}@${host.host}`,
            mask: '*',
            validate: (value) => (value ? true : 'Password is required')
          },
          signal ? { signal } : {}
        )
      });
    } else if (host.authentication.type === 'identityFile') {
      const key = await readFile(host.authentication.path);
      const initialError = validatePrivateKey(key);
      if (initialError && /encrypted|passphrase/i.test(initialError.message)) {
        const passphrase = await password(
          {
            message: `Passphrase for ${host.authentication.path}`,
            mask: '*',
            validate: (value) => (value ? true : 'Passphrase is required')
          },
          signal ? { signal } : {}
        );
        const error = validatePrivateKey(key, passphrase);
        if (error) {
          throw new Error(
            `Cannot use private key ${host.authentication.path}: ${error.message}`
          );
        }
        result.set(name, { passphrase });
      } else if (initialError) {
        throw new Error(
          `Cannot use private key ${host.authentication.path}: ${initialError.message}`
        );
      } else {
        result.set(name, {});
      }
    } else {
      result.set(name, {});
    }
  }
  return result;
}

export async function confirmUnknownHostKey(
  key: UnknownHostKey,
  signal?: AbortSignal
): Promise<boolean> {
  console.log(`\nUnknown SSH host: ${key.host}:${key.port}`);
  console.log(`Key type: ${key.keyType}`);
  console.log(`Fingerprint: ${key.fingerprint}`);
  return await confirm(
    {
      message: 'Trust this SSH host and save its fingerprint?',
      default: false
    },
    signal ? { signal } : {}
  );
}

export async function confirmChangedHostKey(
  key: ChangedHostKey
): Promise<boolean> {
  console.log(`\nSSH HOST KEY CHANGED: ${key.host}:${key.port}`);
  console.log(`Previous: ${key.previousFingerprint}`);
  console.log(`Received: ${key.fingerprint}`);
  const typed = await input({
    message: `Type ${key.host} to replace the saved fingerprint`
  });
  return typed === key.host;
}
