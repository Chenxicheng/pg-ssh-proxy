import type { Duplex } from 'node:stream';

import type { Config, SshHostConfig } from '../config/config.js';
import { LocalProxy, type ProxyEvent } from './local-proxy.js';

export interface SshTransport {
  readonly isReady: boolean;
  connect(): Promise<void>;
  openChannel(request: {
    sourceHost: string;
    sourcePort: number;
    targetHost: string;
    targetPort: number;
  }): Promise<Duplex>;
  close(): void;
}

export type RuntimeStatus =
  | { host: string; status: 'starting' | 'ready' | 'stopping' }
  | {
      host: string;
      status: 'retrying';
      retryInMs: number;
      attempt: number;
      elapsedMs: number;
      error: string;
    }
  | { host: string; status: 'unavailable'; error: string };

export interface ProxyRuntimeOptions {
  config: Config;
  transportFactory: (
    name: string,
    config: SshHostConfig,
    onClose: (error?: Error) => void
  ) => SshTransport;
  onStatus: (status: RuntimeStatus) => void;
  onProxyEvent: (event: ProxyEvent) => void;
  wait?: (milliseconds: number) => Promise<void>;
}

const retryDelays = [1000, 2000, 5000, 10_000, 30_000] as const;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

function isPermanentFailure(error: Error): boolean {
  if ((error as Error & { permanent?: boolean }).permanent) return true;
  return /authentication|host key|requires (?:an interactive password|ssh agent)/i.test(
    error.message
  );
}

export class ProxyRuntime {
  readonly #options: ProxyRuntimeOptions;
  readonly #wait: (milliseconds: number) => Promise<void>;
  readonly #transports = new Map<string, SshTransport>();
  readonly #proxies: LocalProxy[] = [];
  readonly #retrying = new Set<string>();
  readonly #retryStates = new Map<
    string,
    { retryAt: number; attempt: number; elapsedMs: number }
  >();
  #stopping = false;
  #started = false;

  constructor(options: ProxyRuntimeOptions) {
    this.#options = options;
    this.#wait = options.wait ?? delay;
    for (const [name, config] of Object.entries(options.config.sshHosts)) {
      this.#transports.set(
        name,
        options.transportFactory(name, config, (error) => {
          if (!this.#stopping) {
            this.#startReconnect(name, error);
          }
        })
      );
    }
    for (const [name, config] of Object.entries(options.config.proxies)) {
      const transport = this.#transports.get(config.sshHost);
      if (!transport) {
        throw new Error(
          `Proxy ${name} references missing SSH host ${config.sshHost}`
        );
      }
      this.#proxies.push(
        new LocalProxy({
          name,
          localPort: config.localPort,
          target: config.target,
          openChannel: (request) => transport.openChannel(request),
          onEvent: options.onProxyEvent
        })
      );
    }
  }

  get activeConnections(): number {
    return this.#proxies.reduce(
      (total, proxy) => total + proxy.activeConnections,
      0
    );
  }

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    const startedProxies: LocalProxy[] = [];
    try {
      for (const proxy of this.#proxies) {
        await proxy.start();
        startedProxies.push(proxy);
      }
    } catch (error) {
      await Promise.all(startedProxies.map((proxy) => proxy.stop(0)));
      throw error;
    }

    this.#started = true;
    await Promise.all(
      [...this.#transports.keys()].map((name) => this.#initialConnect(name))
    );
  }

  async stop(gracePeriodMs = 10_000): Promise<void> {
    if (this.#stopping) {
      if (gracePeriodMs === 0) {
        for (const proxy of this.#proxies) proxy.forceStop();
        for (const transport of this.#transports.values()) transport.close();
      }
      return;
    }
    this.#stopping = true;
    for (const host of this.#transports.keys()) {
      this.#options.onStatus({ host, status: 'stopping' });
    }
    await Promise.all(this.#proxies.map((proxy) => proxy.stop(gracePeriodMs)));
    for (const transport of this.#transports.values()) {
      transport.close();
    }
    this.#started = false;
  }

  async retryNow(host: string): Promise<void> {
    const transport = this.#transports.get(host);
    if (!transport) {
      throw new Error(`Unknown SSH host ${host}`);
    }
    if (!transport.isReady) {
      try {
        await this.#attempt(host, transport);
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error(String(error));
        if (isPermanentFailure(failure)) {
          this.#options.onStatus({
            host,
            status: 'unavailable',
            error: failure.message
          });
        } else if (!this.#retrying.has(host)) {
          this.#startReconnect(host, failure);
        } else {
          const retry = this.#retryStates.get(host);
          if (retry) {
            this.#options.onStatus({
              host,
              status: 'retrying',
              retryInMs: Math.max(0, retry.retryAt - Date.now()),
              attempt: retry.attempt,
              elapsedMs: retry.elapsedMs,
              error: failure.message
            });
          }
        }
      }
    }
  }

  async #initialConnect(host: string): Promise<void> {
    const transport = this.#transports.get(host);
    if (!transport) return;
    try {
      await this.#attempt(host, transport);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (isPermanentFailure(failure)) {
        this.#options.onStatus({
          host,
          status: 'unavailable',
          error: failure.message
        });
      } else {
        this.#startReconnect(host, failure);
      }
    }
  }

  async #attempt(host: string, transport: SshTransport): Promise<void> {
    this.#options.onStatus({ host, status: 'starting' });
    await transport.connect();
    this.#options.onStatus({ host, status: 'ready' });
  }

  async #reconnect(host: string, initialError?: Error): Promise<void> {
    if (this.#retrying.has(host) || this.#stopping) {
      return;
    }
    const transport = this.#transports.get(host);
    if (!transport) return;
    this.#retrying.add(host);
    let attempt = 0;
    const startedAt = Date.now();
    let failure = initialError ?? new Error('SSH connection closed');
    try {
      while (!this.#stopping && !transport.isReady) {
        if (isPermanentFailure(failure)) {
          this.#options.onStatus({
            host,
            status: 'unavailable',
            error: failure.message
          });
          return;
        }
        const retryInMs =
          retryDelays[Math.min(attempt, retryDelays.length - 1)] ?? 30_000;
        const status: RuntimeStatus = {
          host,
          status: 'retrying',
          retryInMs,
          attempt: attempt + 1,
          elapsedMs: Date.now() - startedAt,
          error: failure.message
        };
        this.#retryStates.set(host, {
          retryAt: Date.now() + retryInMs,
          attempt: status.attempt,
          elapsedMs: status.elapsedMs
        });
        this.#options.onStatus(status);
        await this.#wait(retryInMs);
        if (this.#stopping || transport.isReady) return;
        try {
          await this.#attempt(host, transport);
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
          attempt += 1;
        }
      }
    } finally {
      this.#retrying.delete(host);
      this.#retryStates.delete(host);
    }
  }

  #startReconnect(host: string, initialError?: Error): void {
    void this.#reconnect(host, initialError).catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.#options.onStatus({
        host,
        status: 'unavailable',
        error: failure.message
      });
    });
  }
}
