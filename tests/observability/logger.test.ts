import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createEventLogger } from '../../src/observability/logger.js';

describe('bounded safe JSONL logging', () => {
  it('writes only connection lifecycle fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pg-ssh-proxy-logs-'));
    const logger = createEventLogger(root);

    logger.proxyEvent({
      type: 'response',
      connectionId: 'connection-1',
      proxy: 'orders-db',
      status: 'connected',
      elapsedMs: 24,
      at: Date.now()
    });
    await logger.close();

    const line = await readFile(join(root, 'pg-ssh-proxy.log'), 'utf8');
    const event = JSON.parse(line) as Record<string, unknown>;
    expect(event).toMatchObject({
      type: 'response',
      connectionId: 'connection-1',
      proxy: 'orders-db',
      status: 'connected',
      elapsedMs: 24
    });
    expect(line).not.toMatch(/sql|password|privateKey|payload/i);
  });

  it('keeps the active log plus the configured number of rotated files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pg-ssh-proxy-roll-'));
    const logger = createEventLogger(root, { size: '256B', rotate: 2 });

    for (let index = 0; index < 30; index += 1) {
      logger.status({
        host: 'production',
        status: 'unavailable',
        error: `failure-${index}-${'x'.repeat(80)}`
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
});
