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

    const line = await readFile(join(root, 'pg-ssh-proxy-run-1.log'), 'utf8');
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
      file.startsWith('pg-ssh-proxy-run-2.log')
    );
    expect(files.sort()).toEqual([
      'pg-ssh-proxy-run-2.log',
      'pg-ssh-proxy-run-2.log.1',
      'pg-ssh-proxy-run-2.log.2'
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

    const entries = (
      await readFile(join(root, 'pg-ssh-proxy-run-3.log'), 'utf8')
    )
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

  it('isolates concurrent runs and records process failures at error level', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pg-ssh-proxy-isolated-log-'));
    const first = createEventLogger(root, {
      context: { runId: 'run-a', version: '1.0.0' }
    });
    const second = createEventLogger(root, {
      context: { runId: 'run-b', version: '1.0.0' }
    });

    first.lifecycle({
      status: 'failed',
      phase: 'process',
      error: 'uncaught failure',
      errorName: 'Error',
      errorCode: 'ERR_TEST'
    });
    second.check({ status: 'starting', phase: 'selection' });
    await Promise.all([first.close(), second.close()]);

    expect(first.filePath).not.toBe(second.filePath);
    const firstEntry = JSON.parse(
      await readFile(first.filePath, 'utf8')
    ) as Record<string, unknown>;
    const secondEntry = JSON.parse(
      await readFile(second.filePath, 'utf8')
    ) as Record<string, unknown>;
    expect(firstEntry).toMatchObject({
      level: 50,
      event: 'runtime',
      status: 'failed',
      phase: 'process',
      errorCode: 'ERR_TEST'
    });
    expect(secondEntry).toMatchObject({
      event: 'check',
      status: 'starting',
      phase: 'selection'
    });
  });

  it('keeps only the configured number of completed runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pg-ssh-proxy-retention-log-'));

    for (const runId of ['oldest', 'middle', 'newest']) {
      const logger = createEventLogger(root, {
        context: { runId, version: '1.0.0' },
        retention: { maxBytes: 1024 * 1024, maxRuns: 2 }
      });
      logger.check({ status: 'starting', phase: 'selection' });
      await logger.close();
    }

    const files = (await readdir(root)).filter((file) => file.endsWith('.log'));
    expect(files.sort()).toEqual([
      'pg-ssh-proxy-middle.log',
      'pg-ssh-proxy-newest.log'
    ]);
  });

  it('does not prune an active run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pg-ssh-proxy-active-log-'));
    const active = createEventLogger(root, {
      context: { runId: 'active', version: '1.0.0' },
      retention: { maxBytes: 1, maxRuns: 0 }
    });
    active.check({ status: 'starting', phase: 'selection' });
    const concurrent = createEventLogger(root, {
      context: { runId: 'concurrent', version: '1.0.0' },
      retention: { maxBytes: 1, maxRuns: 0 }
    });
    await concurrent.close();

    expect(
      (await readdir(root)).some((file) => file === 'pg-ssh-proxy-active.log')
    ).toBe(true);
    await active.close();
  });
});
