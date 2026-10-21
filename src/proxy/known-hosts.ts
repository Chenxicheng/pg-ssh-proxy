import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import lockfile from 'proper-lockfile';

export type HostKeyStatus =
  | {
      status: 'unknown';
      fingerprint: string;
    }
  | {
      status: 'trusted';
      fingerprint: string;
    }
  | {
      status: 'changed';
      fingerprint: string;
      previousFingerprint: string;
      previousKeyType: string;
    };

interface KnownHostEntry {
  host: string;
  keyType: string;
  key: Buffer;
}

function hostToken(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

export function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

function parseEntry(line: string): KnownHostEntry | undefined {
  const [host, keyType, encodedKey] = line.trim().split(/\s+/);
  if (!host || !keyType || !encodedKey || host.startsWith('#')) {
    return undefined;
  }
  return {
    host,
    keyType,
    key: Buffer.from(encodedKey, 'base64')
  };
}

export class KnownHosts {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async check(host: string, port: number, key: Buffer): Promise<HostKeyStatus> {
    const token = hostToken(host, port);
    const entries = (await this.#readLines())
      .map(parseEntry)
      .filter((entry): entry is KnownHostEntry => entry !== undefined);
    const existing = entries.find((entry) => entry.host === token);
    const currentFingerprint = fingerprint(key);

    if (!existing) {
      return { status: 'unknown', fingerprint: currentFingerprint };
    }
    if (existing.key.equals(key)) {
      return { status: 'trusted', fingerprint: currentFingerprint };
    }
    return {
      status: 'changed',
      fingerprint: currentFingerprint,
      previousFingerprint: fingerprint(existing.key),
      previousKeyType: existing.keyType
    };
  }

  async trust(
    host: string,
    port: number,
    keyType: string,
    key: Buffer
  ): Promise<void> {
    await this.#update(host, port, keyType, key);
  }

  async replace(
    host: string,
    port: number,
    keyType: string,
    key: Buffer,
    expectedFingerprint: string
  ): Promise<void> {
    await this.#update(host, port, keyType, key, expectedFingerprint);
  }

  async #update(
    host: string,
    port: number,
    keyType: string,
    key: Buffer,
    expectedFingerprint?: string
  ): Promise<void> {
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const unlock = await lockfile.lock(this.#path, {
      realpath: false,
      retries: { retries: 10, minTimeout: 10, maxTimeout: 50 }
    });
    try {
      const token = hostToken(host, port);
      const replacement = `${token} ${keyType} ${key.toString('base64')}`;
      const lines = await this.#readLines();
      const index = lines.findIndex((line) => parseEntry(line)?.host === token);
      if (index === -1) {
        if (expectedFingerprint) {
          throw new Error(
            `SSH host key for ${host}:${port} changed after confirmation; run check again`
          );
        }
        lines.push(replacement);
      } else {
        const existing = parseEntry(lines[index]!)!;
        if (existing.key.equals(key)) return;
        if (!expectedFingerprint) {
          throw new Error(
            `SSH host key changed for ${host}:${port} while trust was being confirmed`
          );
        }
        if (fingerprint(existing.key) !== expectedFingerprint) {
          throw new Error(
            `SSH host key for ${host}:${port} changed after confirmation; run check again`
          );
        }
        lines[index] = replacement;
      }
      await this.#writeLines(lines);
    } finally {
      await unlock();
    }
  }

  async #readLines(): Promise<string[]> {
    try {
      return (await readFile(this.#path, 'utf8'))
        .split('\n')
        .filter((line) => line.trim().length > 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async #writeLines(lines: string[]): Promise<void> {
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      await chmod(directory, 0o700);
    }
    const temporaryPath = join(directory, `.${randomUUID()}.known-hosts`);
    try {
      const file = await open(temporaryPath, 'wx', 0o600);
      try {
        await file.writeFile(`${lines.join('\n')}\n`, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, this.#path);
      if (process.platform !== 'win32') {
        await chmod(this.#path, 0o600);
      }
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}
