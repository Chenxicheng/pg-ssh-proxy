import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import pino from 'pino';
import lockfile from 'proper-lockfile';
import { createStream } from 'rotating-file-stream';

import type { ProxyEvent } from '../proxy/local-proxy.js';
import type { RuntimeStatus } from '../proxy/runtime.js';
import type { ErrorDetails } from './error-details.js';

export interface LogRotationOptions {
  size: string;
  rotate: number;
}

export interface EventLoggerOptions {
  context: {
    runId: string;
    version: string;
  };
  rotation?: LogRotationOptions;
  retention?: {
    maxBytes: number;
    maxRuns: number;
  };
  onError?: (error: Error) => void;
  onWarning?: (error: Error) => void;
}

const DEFAULT_RETENTION = {
  maxBytes: 100 * 1024 * 1024,
  maxRuns: 20
};

function logBaseName(fileName: string): string | undefined {
  if (!fileName.startsWith('pg-ssh-proxy-')) return undefined;
  const suffixIndex = fileName.indexOf('.log');
  if (suffixIndex === -1) return undefined;
  const suffix = fileName.slice(suffixIndex + 4);
  if (suffix !== '' && !/^\.\d+$/.test(suffix)) return undefined;
  return fileName.slice(0, suffixIndex + 4);
}

function pruneInactiveLogs(
  logDirectory: string,
  retention: { maxBytes: number; maxRuns: number },
  onWarning: (error: Error) => void
): void {
  const retentionLockPath = join(logDirectory, '.retention');
  let releaseRetentionLock: (() => void) | undefined;
  try {
    releaseRetentionLock = lockfile.lockSync(retentionLockPath, {
      realpath: false,
      retries: 0,
      stale: 15_000,
      update: 5000
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED') return;
    onWarning(error instanceof Error ? error : new Error(String(error)));
    return;
  }

  try {
    const runs = new Map<
      string,
      {
        files: Array<{ path: string; size: number }>;
        size: number;
        mtime: number;
      }
    >();
    for (const entry of readdirSync(logDirectory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const baseName = logBaseName(entry.name);
      if (!baseName) continue;
      const path = join(logDirectory, entry.name);
      const metadata = statSync(path);
      const run = runs.get(baseName) ?? { files: [], size: 0, mtime: 0 };
      run.files.push({ path, size: metadata.size });
      run.size += metadata.size;
      run.mtime = Math.max(run.mtime, metadata.mtimeMs);
      runs.set(baseName, run);
    }

    const inactiveRuns = [...runs.entries()]
      .filter(([baseName]) => {
        try {
          return !lockfile.checkSync(join(logDirectory, baseName), {
            realpath: false,
            stale: 15_000
          });
        } catch {
          return false;
        }
      })
      .map(([, run]) => run)
      .sort((left, right) => left.mtime - right.mtime);
    let inactiveBytes = inactiveRuns.reduce((sum, run) => sum + run.size, 0);
    let inactiveCount = inactiveRuns.length;

    for (const run of inactiveRuns) {
      if (
        inactiveBytes <= retention.maxBytes &&
        inactiveCount <= retention.maxRuns
      ) {
        break;
      }
      for (const file of run.files) rmSync(file.path, { force: true });
      inactiveBytes -= run.size;
      inactiveCount -= 1;
    }
  } catch (error) {
    onWarning(error instanceof Error ? error : new Error(String(error)));
  } finally {
    releaseRetentionLock();
  }
}

export type RuntimeLifecycleEvent =
  | {
      status: 'starting';
      proxyCount: number;
      sshHostCount: number;
    }
  | { status: 'ready'; startupMs: number }
  | (Partial<ErrorDetails> & {
      status: 'stopping';
      reason: string;
      activeConnections: number;
      phase?: 'process';
    })
  | { status: 'stopped'; elapsedMs: number }
  | (ErrorDetails & {
      status: 'failed';
      phase:
        | 'config'
        | 'credentials'
        | 'runtime_start'
        | 'fullscreen'
        | 'running'
        | 'process';
    });

export type CheckEvent =
  | {
      status: 'starting' | 'succeeded';
      phase:
        | 'selection'
        | 'credentials'
        | 'ssh_connect'
        | 'forward_out'
        | 'complete';
      sshHost?: string;
      proxy?: string;
      elapsedMs?: number;
    }
  | (ErrorDetails & {
      status: 'failed';
      phase: 'selection' | 'credentials' | 'ssh_connect' | 'forward_out';
      sshHost?: string;
      proxy?: string;
      elapsedMs: number;
    });

export interface EventLogger {
  readonly filePath: string;
  check(event: CheckEvent): void;
  lifecycle(event: RuntimeLifecycleEvent): void;
  proxyEvent(event: ProxyEvent): void;
  status(status: RuntimeStatus): void;
  close(): Promise<void>;
}

export function createEventLogger(
  logDirectory: string,
  options: EventLoggerOptions
): EventLogger {
  const rotation = options.rotation ?? { size: '5M', rotate: 4 };
  const retention = options.retention ?? DEFAULT_RETENTION;
  const onError = options.onError ?? (() => undefined);
  const onWarning = options.onWarning ?? (() => undefined);
  mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    chmodSync(logDirectory, 0o700);
  }
  const fileName = `pg-ssh-proxy-${options.context.runId}.log`;
  const filePath = join(logDirectory, fileName);
  const releaseRunLock = lockfile.lockSync(filePath, {
    realpath: false,
    retries: 0,
    stale: 15_000,
    update: 5000,
    onCompromised: onError
  });
  const { stream, logger } = (() => {
    try {
      pruneInactiveLogs(logDirectory, retention, onWarning);
      const nextStream = createStream(fileName, {
        path: logDirectory,
        size: rotation.size,
        rotate: rotation.rotate,
        mode: 0o600
      });
      nextStream.on('error', onError);
      nextStream.on('warning', onWarning);
      const nextLogger = pino(
        {
          base: {
            service: 'pg-ssh-proxy',
            version: options.context.version,
            runId: options.context.runId,
            pid: process.pid,
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch
          }
        },
        nextStream
      );
      return { stream: nextStream, logger: nextLogger };
    } catch (error) {
      releaseRunLock();
      throw error;
    }
  })();
  let closed = false;

  return {
    filePath,
    check(event) {
      const entry = { event: 'check', ...event };
      if (event.status === 'failed') {
        logger.error(entry);
      } else {
        logger.info(entry);
      }
    },
    lifecycle(event) {
      const entry = { event: 'runtime', ...event };
      if (event.status === 'failed') {
        logger.error(entry);
      } else {
        logger.info(entry);
      }
    },
    proxyEvent(event) {
      const entry = { event: 'proxy_connection', ...event };
      if (event.type === 'response' && event.status === 'failed') {
        logger.warn(entry);
      } else {
        logger.info(entry);
      }
    },
    status(status) {
      const entry = { event: 'ssh_status', ...status };
      if (status.status === 'unavailable') {
        logger.error(entry);
      } else if (status.status === 'retrying') {
        logger.warn(entry);
      } else {
        logger.info(entry);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        if (!stream.destroyed && !stream.closed && !stream.writableFinished) {
          await new Promise<void>((resolve) => {
            const done = () => resolve();
            stream.once('finish', done);
            stream.once('close', done);
            stream.once('error', done);
            stream.end();
          });
        }
      } finally {
        releaseRunLock();
        pruneInactiveLogs(logDirectory, retention, onWarning);
      }
    }
  };
}
