import { readFile } from 'node:fs/promises';
import type { Duplex } from 'node:stream';

import ssh2, { type Client as SshClient, type ConnectConfig } from 'ssh2';

const { Client } = ssh2;

import type { SshHostConfig } from '../config/config.js';
import { KnownHosts, fingerprint } from './known-hosts.js';

export interface InteractiveCredentials {
  password?: string;
  passphrase?: string;
}

export interface UnknownHostKey {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
}

export interface ChangedHostKey extends UnknownHostKey {
  previousFingerprint: string;
}

export interface SshConnectionOptions {
  name: string;
  config: SshHostConfig;
  knownHosts: KnownHosts;
  credentials: InteractiveCredentials;
  confirmUnknownHost: (
    hostKey: UnknownHostKey,
    isActive: () => boolean
  ) => Promise<boolean>;
  confirmChangedHost?: (hostKey: ChangedHostKey) => Promise<boolean>;
  onClose: (error?: Error) => void;
}

function readKeyType(key: Buffer): string {
  if (key.length < 4) return 'unknown';
  const length = key.readUInt32BE(0);
  if (length === 0 || length > key.length - 4) return 'unknown';
  const type = key.subarray(4, 4 + length).toString('ascii');
  return /^[a-z0-9@._+-]+$/i.test(type) ? type : 'unknown';
}

export class SshConnection {
  readonly #options: SshConnectionOptions;
  #client: SshClient | undefined;
  #ready = false;
  #connecting: Promise<void> | undefined;

  constructor(options: SshConnectionOptions) {
    this.#options = options;
  }

  get isReady(): boolean {
    return this.#ready;
  }

  async connect(): Promise<void> {
    if (this.#ready) {
      return;
    }
    if (this.#connecting) return await this.#connecting;
    this.#connecting = this.#connect();
    try {
      await this.#connecting;
    } finally {
      this.#connecting = undefined;
    }
  }

  async #connect(): Promise<void> {
    const client = new Client();
    this.#client = client;
    let hostKeyError: Error | undefined;
    const connectConfig = await this.#connectConfig(client, (error) => {
      hostKeyError = error;
    });
    if (this.#client !== client) {
      client.end();
      throw new Error(`SSH connection ${this.#options.name} was cancelled`);
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        if (this.#client === client) this.#client = undefined;
        client.end();
        reject(hostKeyError ?? error);
      };
      client.once('ready', () => {
        if (this.#client !== client) {
          fail(new Error(`SSH connection ${this.#options.name} was cancelled`));
          return;
        }
        settled = true;
        this.#ready = true;
        resolve();
      });
      client.once('error', fail);
      client.once('close', () => {
        const wasReady = this.#ready;
        this.#ready = false;
        if (!settled) {
          fail(new Error(`SSH connection ${this.#options.name} closed`));
          return;
        }
        if (wasReady) {
          this.#options.onClose();
        }
      });
      client.connect(connectConfig);
    });
  }

  async openChannel(request: {
    sourceHost: string;
    sourcePort: number;
    targetHost: string;
    targetPort: number;
  }): Promise<Duplex> {
    const client = this.#client;
    if (!client || !this.#ready) {
      throw new Error(`SSH host ${this.#options.name} is unavailable`);
    }
    return await new Promise<Duplex>((resolve, reject) => {
      client.forwardOut(
        request.sourceHost,
        request.sourcePort,
        request.targetHost,
        request.targetPort,
        (error, channel) => {
          if (error) {
            reject(error);
          } else {
            resolve(channel);
          }
        }
      );
    });
  }

  close(): void {
    this.#ready = false;
    this.#client?.end();
    this.#client = undefined;
  }

  async #connectConfig(
    client: SshClient,
    setHostKeyError: (error: Error) => void
  ): Promise<ConnectConfig> {
    const { config, knownHosts, credentials } = this.#options;
    const authentication = config.authentication;
    const result: ConnectConfig = {
      host: config.host,
      port: config.port,
      username: config.username,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
      readyTimeout: 20_000,
      hostVerifier: (key: Buffer, verify: (accepted: boolean) => void) => {
        void (async () => {
          const keyType = readKeyType(key);
          const isActive = () => this.#client === client;
          const status = await knownHosts.check(config.host, config.port, key);
          if (status.status === 'trusted') {
            verify(true);
            return;
          }
          if (status.status === 'changed') {
            if (!isActive()) {
              verify(false);
              return;
            }
            const accepted = await this.#options.confirmChangedHost?.({
              host: config.host,
              port: config.port,
              keyType,
              fingerprint: status.fingerprint,
              previousFingerprint: status.previousFingerprint
            });
            if (accepted && isActive()) {
              await knownHosts.replace(
                config.host,
                config.port,
                keyType,
                key,
                status.previousFingerprint
              );
              verify(true);
              return;
            }
            const error = new PermanentSshError(
              `SSH host key changed for ${config.host}:${config.port}; expected ${status.previousFingerprint}, received ${status.fingerprint}`
            );
            setHostKeyError(error);
            verify(false);
            return;
          }
          if (!isActive()) {
            verify(false);
            return;
          }
          const accepted = await this.#options.confirmUnknownHost(
            {
              host: config.host,
              port: config.port,
              keyType,
              fingerprint: fingerprint(key)
            },
            isActive
          );
          if (accepted && isActive()) {
            await knownHosts.trust(config.host, config.port, keyType, key);
          } else {
            setHostKeyError(
              new PermanentSshError(
                `SSH host ${config.host}:${config.port} was not trusted`
              )
            );
          }
          verify(accepted && isActive());
        })().catch((error: unknown) => {
          setHostKeyError(
            error instanceof Error ? error : new Error(String(error))
          );
          verify(false);
        });
      }
    };

    if (authentication.type === 'agent') {
      const agent = process.env.SSH_AUTH_SOCK;
      if (!agent) {
        throw new Error(
          `SSH host ${this.#options.name} requires SSH Agent, but SSH_AUTH_SOCK is not set`
        );
      }
      result.agent = agent;
    } else if (authentication.type === 'identityFile') {
      result.privateKey = await readFile(authentication.path);
      if (credentials.passphrase) {
        result.passphrase = credentials.passphrase;
      }
    } else {
      if (!credentials.password) {
        throw new Error(
          `SSH host ${this.#options.name} requires an interactive password`
        );
      }
      result.password = credentials.password;
    }
    return result;
  }
}

class PermanentSshError extends Error {
  readonly permanent = true;
}
