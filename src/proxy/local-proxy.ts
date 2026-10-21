import { randomUUID } from 'node:crypto';
import {
  createServer,
  type AddressInfo,
  type Server,
  type Socket
} from 'node:net';
import type { Duplex } from 'node:stream';

export type ProxyEvent =
  | {
      type: 'request';
      connectionId: string;
      proxy: string;
      client: string;
      at: number;
    }
  | {
      type: 'response';
      connectionId: string;
      proxy: string;
      status: 'connected' | 'failed';
      elapsedMs: number;
      error?: string;
      at: number;
    }
  | {
      type: 'close';
      connectionId: string;
      proxy: string;
      elapsedMs: number;
      bytesFromClient: number;
      bytesToClient: number;
      reason: string;
      at: number;
    };

export type OpenChannel = (request: {
  sourceHost: string;
  sourcePort: number;
  targetHost: string;
  targetPort: number;
}) => Promise<Duplex>;

export interface LocalProxyOptions {
  name: string;
  localPort: number;
  target: {
    host: string;
    port: number;
  };
  openChannel: OpenChannel;
  onEvent: (event: ProxyEvent) => void;
}

interface ActiveConnection {
  socket: Socket;
  channel?: Duplex;
  close?: (reason: string) => void;
}

export class LocalProxy {
  readonly #options: LocalProxyOptions;
  readonly #server: Server;
  readonly #active = new Map<string, ActiveConnection>();
  #boundPort: number | undefined;

  constructor(options: LocalProxyOptions) {
    this.#options = options;
    this.#server = createServer((socket) => {
      void this.#accept(socket).catch(() => socket.destroy());
    });
  }

  get localPort(): number {
    if (this.#boundPort === undefined) {
      throw new Error(`Proxy ${this.#options.name} is not listening`);
    }
    return this.#boundPort;
  }

  get activeConnections(): number {
    return this.#active.size;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.#server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.#server.off('error', onError);
        resolve();
      };
      this.#server.once('error', onError);
      this.#server.once('listening', onListening);
      this.#server.listen(this.#options.localPort, '127.0.0.1');
    });
    this.#boundPort = (this.#server.address() as AddressInfo).port;
  }

  async stop(gracePeriodMs: number): Promise<void> {
    if (!this.#server.listening) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.#closeActive('grace period expired');
      }, gracePeriodMs);
      timer.unref();
      this.#server.close(finish);
    });
  }

  forceStop(): void {
    this.#closeActive('forced shutdown');
    if (this.#server.listening) this.#server.close();
  }

  #closeActive(reason: string): void {
    for (const connection of this.#active.values()) {
      if (connection.close) {
        connection.close(reason);
      } else {
        connection.channel?.destroy();
        connection.socket.destroy();
      }
    }
  }

  async #accept(socket: Socket): Promise<void> {
    const connectionId = randomUUID();
    const startedAt = Date.now();
    const sourceHost = socket.remoteAddress ?? '127.0.0.1';
    const sourcePort = socket.remotePort ?? 0;
    const active: ActiveConnection = { socket };
    this.#active.set(connectionId, active);
    this.#options.onEvent({
      type: 'request',
      connectionId,
      proxy: this.#options.name,
      client: `${sourceHost}:${sourcePort}`,
      at: startedAt
    });

    let channel: Duplex;
    try {
      channel = await this.#options.openChannel({
        sourceHost,
        sourcePort,
        targetHost: this.#options.target.host,
        targetPort: this.#options.target.port
      });
    } catch (error) {
      this.#active.delete(connectionId);
      this.#options.onEvent({
        type: 'response',
        connectionId,
        proxy: this.#options.name,
        status: 'failed',
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        at: Date.now()
      });
      socket.destroy();
      return;
    }

    active.channel = channel;
    this.#options.onEvent({
      type: 'response',
      connectionId,
      proxy: this.#options.name,
      status: 'connected',
      elapsedMs: Date.now() - startedAt,
      at: Date.now()
    });

    let bytesFromClient = 0;
    let bytesToClient = 0;
    let closed = false;
    socket.on('data', (chunk: Buffer) => {
      bytesFromClient += chunk.length;
    });
    channel.on('data', (chunk: Buffer) => {
      bytesToClient += chunk.length;
    });
    const close = (reason: string) => {
      if (closed) return;
      closed = true;
      this.#active.delete(connectionId);
      socket.destroy();
      channel.destroy();
      this.#options.onEvent({
        type: 'close',
        connectionId,
        proxy: this.#options.name,
        elapsedMs: Date.now() - startedAt,
        bytesFromClient,
        bytesToClient,
        reason,
        at: Date.now()
      });
    };
    active.close = close;
    socket.once('error', (error) => close(`client error: ${error.message}`));
    channel.once('error', (error) =>
      close(`SSH channel error: ${error.message}`)
    );
    socket.once('close', () => close('client closed'));
    channel.once('close', () => close('SSH channel closed'));
    socket.pipe(channel);
    channel.pipe(socket);
  }
}
