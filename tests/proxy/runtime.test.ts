import { createServer } from 'node:net';
import { Transform, type Duplex } from 'node:stream';
import { once } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import type { Config } from '../../src/config/config.js';
import {
  ProxyRuntime,
  type RuntimeStatus,
  type SshTransport
} from '../../src/proxy/runtime.js';

async function reservePort(): Promise<{
  port: number;
  release: () => Promise<void>;
}> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No TCP address');
  return {
    port: address.port,
    release: async () => {
      server.close();
      await once(server, 'close');
    }
  };
}

function configFor(localPorts: [number, number]): Config {
  return {
    sshHosts: {
      production: {
        host: 'production.example.com',
        port: 22,
        username: 'deploy',
        authentication: { type: 'agent' }
      },
      staging: {
        host: 'staging.example.com',
        port: 22,
        username: 'deploy',
        authentication: { type: 'agent' }
      }
    },
    proxies: {
      production: {
        localPort: localPorts[0],
        sshHost: 'production',
        target: { host: 'postgres.internal', port: 5432 }
      },
      staging: {
        localPort: localPorts[1],
        sshHost: 'staging',
        target: { host: 'postgres.internal', port: 5432 }
      }
    }
  };
}

class FakeTransport implements SshTransport {
  isReady = false;
  connectAttempts = 0;
  readonly #failures: number;

  constructor(failures = 0) {
    this.#failures = failures;
  }

  async connect(): Promise<void> {
    this.connectAttempts += 1;
    if (this.connectAttempts <= this.#failures) {
      throw Object.assign(new Error('connect refused'), {
        code: 'ECONNREFUSED'
      });
    }
    this.isReady = true;
  }

  async openChannel(): Promise<Duplex> {
    if (!this.isReady) throw new Error('SSH unavailable');
    return new Transform({
      transform(chunk, _encoding, callback) {
        callback(null, chunk);
      }
    });
  }

  close(): void {
    this.isReady = false;
  }
}

describe('runtime lifecycle seam', () => {
  it('binds every local port before attempting SSH', async () => {
    const first = await reservePort();
    await first.release();
    const occupied = await reservePort();
    const connect = vi.fn();
    const runtime = new ProxyRuntime({
      config: configFor([first.port, occupied.port]),
      transportFactory: () => ({
        isReady: false,
        connect,
        openChannel: async () => {
          throw new Error('not used');
        },
        close: vi.fn()
      }),
      onStatus: vi.fn(),
      onProxyEvent: vi.fn()
    });

    await expect(runtime.start()).rejects.toMatchObject({
      code: 'EADDRINUSE'
    });
    expect(connect).not.toHaveBeenCalled();

    const rebound = createServer();
    rebound.listen(first.port, '127.0.0.1');
    await once(rebound, 'listening');
    rebound.close();
    await once(rebound, 'close');
    await occupied.release();
  });

  it('retries one failed SSH host without blocking ready hosts', async () => {
    const first = await reservePort();
    await first.release();
    const second = await reservePort();
    await second.release();
    const production = new FakeTransport();
    const staging = new FakeTransport(1);
    const statuses: RuntimeStatus[] = [];
    const delays: number[] = [];
    const runtime = new ProxyRuntime({
      config: configFor([first.port, second.port]),
      transportFactory: (name) =>
        name === 'production' ? production : staging,
      wait: async (milliseconds) => {
        delays.push(milliseconds);
      },
      onStatus: (status) => statuses.push(status),
      onProxyEvent: vi.fn()
    });

    await runtime.start();
    await vi.waitFor(() => {
      expect(staging.isReady).toBe(true);
    });

    expect(production.connectAttempts).toBe(1);
    expect(staging.connectAttempts).toBe(2);
    expect(delays).toEqual([1000]);
    expect(statuses).toContainEqual({
      host: 'production',
      status: 'ready'
    });
    expect(statuses).toContainEqual({
      host: 'staging',
      status: 'retrying',
      retryInMs: 1000,
      attempt: 1,
      elapsedMs: expect.any(Number),
      phase: 'ssh_connect',
      error: 'connect refused',
      errorName: 'Error',
      errorCode: 'ECONNREFUSED'
    });
    await runtime.stop(100);
  });

  it('does not reconnect again after an immediate retry succeeds', async () => {
    const first = await reservePort();
    await first.release();
    const second = await reservePort();
    await second.release();
    const production = new FakeTransport();
    const staging = new FakeTransport(1);
    let releaseWait: (() => void) | undefined;
    const runtime = new ProxyRuntime({
      config: configFor([first.port, second.port]),
      transportFactory: (name) =>
        name === 'production' ? production : staging,
      wait: () =>
        new Promise<void>((resolve) => {
          releaseWait = resolve;
        }),
      onStatus: vi.fn(),
      onProxyEvent: vi.fn()
    });

    await runtime.start();
    await vi.waitFor(() => expect(releaseWait).toBeDefined());
    await runtime.retryNow('staging');
    releaseWait?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(staging.connectAttempts).toBe(2);
    await runtime.stop(100);
  });
});
