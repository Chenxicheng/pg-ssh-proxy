import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import type { Config } from '../../src/config/config.js';
import type { ProxyEvent } from '../../src/proxy/local-proxy.js';
import {
  Dashboard,
  DashboardModel,
  formatStatusLine
} from '../../src/cli/dashboard.js';

const config: Config = {
  sshHosts: {
    production: {
      host: 'bastion.example.com',
      port: 22,
      username: 'deploy',
      authentication: { type: 'agent' }
    }
  },
  proxies: {
    'orders-db': {
      localPort: 15432,
      sshHost: 'production',
      target: { host: 'postgres.internal', port: 5432 }
    }
  }
};

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('fullscreen user-visible seam', () => {
  it('fills the terminal on startup and after resizing', async () => {
    const view = render(
      <Dashboard
        model={new DashboardModel(config)}
        onQuit={vi.fn()}
        onRetry={vi.fn()}
      />
    );
    try {
      await tick();
      expect((view.lastFrame() ?? '').split('\n')).toHaveLength(24);

      for (const [columns, rows] of [
        [140, 40],
        [80, 20]
      ] as const) {
        Object.defineProperty(view.stdout, 'columns', {
          value: columns,
          configurable: true
        });
        Object.defineProperty(view.stdout, 'rows', {
          value: rows,
          configurable: true
        });
        view.stdout.emit('resize');
        await tick();
        const lines = (view.lastFrame() ?? '').split('\n');
        expect(lines).toHaveLength(rows);
        expect(lines[0]).toHaveLength(columns);
        expect(lines.at(-2)).toContain('q quit');
      }
    } finally {
      view.unmount();
      view.cleanup();
    }
  });

  it('shows proxy status, connection events and selected detail', async () => {
    const model = new DashboardModel(config);
    model.status({ host: 'production', status: 'ready' });
    const request: ProxyEvent = {
      type: 'request',
      connectionId: 'connection-123',
      proxy: 'orders-db',
      client: '127.0.0.1:51824',
      phase: 'local_accept',
      at: Date.now()
    };
    model.proxyEvent(request);

    const view = render(
      <Dashboard model={model} onQuit={vi.fn()} onRetry={vi.fn()} />
    );
    await tick();

    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('orders-db');
    expect(frame).toContain('127.0.0.1:15432');
    expect(frame).toContain('REQ');
    expect(frame).toContain('connection-123');
    view.unmount();
  });

  it('maps q and r to graceful quit and retry', async () => {
    const model = new DashboardModel(config);
    model.status({
      host: 'production',
      status: 'retrying',
      retryInMs: 1000,
      attempt: 1,
      elapsedMs: 250,
      phase: 'ssh_connect',
      error: 'connect refused',
      errorName: 'Error',
      errorCode: 'ECONNREFUSED'
    });
    const onQuit = vi.fn();
    const onRetry = vi.fn();
    const view = render(
      <Dashboard model={model} onQuit={onQuit} onRetry={onRetry} />
    );
    await tick();

    expect(view.lastFrame()).toContain('retry in 1s');

    view.stdin.write('r');
    await tick();
    view.stdin.write('q');
    await tick();

    expect(onRetry).toHaveBeenCalledWith('production');
    expect(onQuit).toHaveBeenCalledOnce();
    view.unmount();
  });

  it('formats a text-only fallback without relying on color', () => {
    expect(
      formatStatusLine({
        host: 'production',
        status: 'unavailable',
        phase: 'ssh_connect',
        error: 'SSH authentication failed',
        errorName: 'Error'
      })
    ).toBe(
      '[UNAVAILABLE] production · SSH authentication failed · action required'
    );
  });

  it('pauses connection scrolling without freezing proxy status', async () => {
    const model = new DashboardModel(config);
    const view = render(
      <Dashboard model={model} onQuit={vi.fn()} onRetry={vi.fn()} />
    );
    view.stdin.write(' ');
    model.status({ host: 'production', status: 'ready' });
    await tick();

    expect(view.lastFrame()).toContain('ready');
    expect(view.lastFrame()).toContain('paused');
    view.unmount();
  });
});
