import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createEventLogger } from '../../src/observability/logger.js';

describe('bounded safe JSONL logging', () => {
  it('writes only connection lifecycle fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pg-ssh-proxy-logs-'));
    const logger = createEventLogger(root, {
      context: { runId: 'run-1', version: '1.0.0' }
    });

    logger.proxyEvent({
      type: 'response',
      connectionId: 'connection-1',
      proxy: 'orders-db',
      status: 'connected',
      phase: 'forward_out',
      elapsedMs: 24,
      at: Date.now()
    });
    await logger.close();

    const line = await readFile(join(root, 'pg-ssh-proxy.log'), 'utf8');
    const event = JSON.parse(line) as Record<string, unknown>;
    expect(event).toMatchObject({
      event: 'proxy_connection',
      service: 'pg-ssh-proxy',
      version: '1.0.0',
      runId: 'run-1',
      type: 'response',
      connectionId: 'connection-1',
      proxy: 'orders-db',
      status: 'connected',
      phase: 'forward_out',
      elapsedMs: 24
    });
    expect(line).not.toMatch(/sql|password|privateKey|payload/i);
  });

  it('keeps the active log plus the configured number of rotated files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pg-ssh-proxy-roll-'));
    const logger = createEventLogger(root, {
      context: { runId: 'run-2', version: '1.0.0' },
      rotation: { size: '256B', rotate: 2 }
    });

    for (let index = 0; index < 30; index += 1) {
      logger.status({
        host: 'production',
        status: 'unavailable',
        phase: 'ssh_connect',
        error: `failure-${index}-${'x'.repeat(80)}`,
        errorName: 'Error',
        errorCode: 'ECONNREFUSED'
      });
    }
    await logger.close();

    const files = (await readdir(root)).filter((file) =>
      file.startsWith('pg-ssh-proxy.log')
    );
    expect(files.sort()).toEqual([
      'pg-ssh-proxy.log',
      'pg-ssh-proxy.log.1',
      'pg-ssh-proxy.log.2'
    ]);
  });

  it('records runtime lifecycle with environment metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pg-ssh-proxy-runtime-log-'));
    const logger = createEventLogger(root, {
      context: { runId: 'run-3', version: '1.0.0' }
    });

    logger.lifecycle({ status: 'starting', proxyCount: 2, sshHostCount: 1 });
    logger.lifecycle({ status: 'ready', startupMs: 42 });
    logger.check({
      status: 'failed',
      phase: 'forward_out',
      sshHost: 'production',
      proxy: 'orders-db',
      elapsedMs: 25,
      error: 'network unreachable',
      errorName: 'Error',
      errorCode: 'ENETUNREACH'
    });
    await logger.close();

    const entries = (await readFile(join(root, 'pg-ssh-proxy.log'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      event: 'runtime',
      status: 'starting',
      proxyCount: 2,
      sshHostCount: 1,
      runId: 'run-3',
      version: '1.0.0',
      pid: process.pid,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch
    });
    expect(entries[1]).toMatchObject({
      event: 'runtime',
      status: 'ready',
      startupMs: 42
    });
    expect(entries[2]).toMatchObject({
      event: 'check',
      status: 'failed',
      phase: 'forward_out',
      sshHost: 'production',
      proxy: 'orders-db',
      errorCode: 'ENETUNREACH'
    });
  });
});
