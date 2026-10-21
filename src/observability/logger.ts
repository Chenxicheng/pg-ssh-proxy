import { chmodSync, mkdirSync } from 'node:fs';

import pino from 'pino';
import { createStream } from 'rotating-file-stream';

import type { ProxyEvent } from '../proxy/local-proxy.js';
import type { RuntimeStatus } from '../proxy/runtime.js';

export interface LogRotationOptions {
  size: string;
  rotate: number;
}

export interface EventLogger {
  proxyEvent(event: ProxyEvent): void;
  status(status: RuntimeStatus): void;
  close(): Promise<void>;
}

export function createEventLogger(
  logDirectory: string,
  rotation: LogRotationOptions = { size: '5M', rotate: 4 },
  onError: (error: Error) => void = () => undefined
): EventLogger {
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
  stream.on('error', onError);
  const logger = pino({ base: null }, stream);
  let closed = false;

  return {
    proxyEvent(event) {
      logger.info(event);
    },
    status(status) {
      logger.info(status);
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
