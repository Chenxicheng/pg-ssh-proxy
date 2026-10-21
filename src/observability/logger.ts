import { chmodSync, mkdirSync } from 'node:fs';

import pino from 'pino';
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
  onError?: (error: Error) => void;
  onWarning?: (error: Error) => void;
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
        'config' | 'credentials' | 'runtime_start' | 'fullscreen' | 'running';
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
  mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    chmodSync(logDirectory, 0o700);
  }
  const stream = createStream('pg-ssh-proxy.log', {
    path: logDirectory,
    size: rotation.size,
    rotate: rotation.rotate,
    mode: 0o600
  });
  stream.on('error', options.onError ?? (() => undefined));
  stream.on('warning', options.onWarning ?? (() => undefined));
  const logger = pino(
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
    stream
  );
  let closed = false;

  return {
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
      if (stream.destroyed || stream.closed || stream.writableFinished) return;
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        stream.once('finish', done);
        stream.once('close', done);
        stream.once('error', done);
        stream.end();
      });
    }
  };
}
