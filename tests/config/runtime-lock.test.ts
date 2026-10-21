import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  acquireConfigMutationLock,
  acquireRuntimeLock,
  AlreadyRunningError
} from '../../src/config/runtime-lock.js';

describe('single runtime instance', () => {
  it('reports the active instance and permits a new one after release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pg-ssh-proxy-lock-'));
    const runtimePath = join(root, 'runtime.json');
    const first = await acquireRuntimeLock(runtimePath, {
      pid: 1234,
      startedAt: '2026-10-20T12:00:00.000Z',
      proxies: 3
    });

    await expect(
      acquireRuntimeLock(runtimePath, {
        pid: 5678,
        startedAt: '2026-10-20T12:01:00.000Z',
        proxies: 1
      })
    ).rejects.toEqual(
      new AlreadyRunningError({
        pid: 1234,
        startedAt: '2026-10-20T12:00:00.000Z',
        proxies: 3
      })
    );

    await first.release();
    const second = await acquireRuntimeLock(runtimePath, {
      pid: 5678,
      startedAt: '2026-10-20T12:01:00.000Z',
      proxies: 1
    });
    await second.release();
  });

  it('prevents runtime startup while configuration is being edited', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pg-ssh-proxy-lock-'));
    const runtimePath = join(root, 'runtime.json');
    const mutation = await acquireConfigMutationLock(runtimePath);

    await expect(
      acquireRuntimeLock(runtimePath, {
        pid: 1234,
        startedAt: '2026-10-20T12:00:00.000Z',
        proxies: 1
      })
    ).rejects.toBeInstanceOf(AlreadyRunningError);

    await mutation.release();
  });
});
