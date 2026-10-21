import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import lockfile from 'proper-lockfile';

export interface RuntimeMetadata {
  pid: number;
  startedAt: string;
  proxies: number;
}

export class AlreadyRunningError extends Error {
  readonly metadata: RuntimeMetadata | undefined;

  constructor(metadata?: RuntimeMetadata) {
    super('pg-ssh-proxy is already running');
    this.name = 'AlreadyRunningError';
    this.metadata = metadata;
  }
}

export interface RuntimeLock {
  release(): Promise<void>;
}

export interface ActiveRuntimeLock extends RuntimeLock {
  update(metadata: RuntimeMetadata): Promise<void>;
}

async function readMetadata(
  path: string
): Promise<RuntimeMetadata | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as RuntimeMetadata;
  } catch {
    return undefined;
  }
}

export async function acquireConfigMutationLock(
  runtimePath: string
): Promise<RuntimeLock> {
  const directory = dirname(runtimePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(directory, 0o700);
  let unlock: (() => Promise<void>) | undefined;
  try {
    unlock = await lockfile.lock(runtimePath, {
      realpath: false,
      retries: 0,
      stale: 15_000,
      update: 5000
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED') {
      throw new AlreadyRunningError(await readMetadata(runtimePath));
    }
    throw error;
  }
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await unlock();
    }
  };
}

export async function acquireRuntimeLock(
  runtimePath: string,
  metadata: RuntimeMetadata
): Promise<ActiveRuntimeLock> {
  const directory = dirname(runtimePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await chmod(directory, 0o700);
  }

  let unlock: (() => Promise<void>) | undefined;
  try {
    unlock = await lockfile.lock(runtimePath, {
      realpath: false,
      retries: 0,
      stale: 15_000,
      update: 5000
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED') {
      throw new AlreadyRunningError(await readMetadata(runtimePath));
    }
    throw error;
  }

  try {
    await writeFile(runtimePath, `${JSON.stringify(metadata, null, 2)}\n`, {
      mode: 0o600
    });
    if (process.platform !== 'win32') {
      await chmod(runtimePath, 0o600);
    }
  } catch (error) {
    await unlock();
    throw error;
  }

  let released = false;
  return {
    async update(nextMetadata) {
      await writeFile(
        runtimePath,
        `${JSON.stringify(nextMetadata, null, 2)}\n`,
        { mode: 0o600 }
      );
    },
    async release() {
      if (released) return;
      released = true;
      try {
        await rm(runtimePath, { force: true });
      } finally {
        await unlock();
      }
    }
  };
}
