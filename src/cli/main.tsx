#!/usr/bin/env node

import { access } from 'node:fs/promises';

import { Command } from 'commander';
import { render, type Instance } from 'ink';
import React from 'react';

import {
  addProxy,
  editProxy,
  loadConfigOrEmpty,
  printConfig,
  removeProxy,
  UserCancelledError
} from './config-wizard.js';
import {
  confirmChangedHostKey,
  confirmUnknownHostKey,
  promptCredentials
} from './credentials.js';
import { Dashboard, DashboardModel, formatStatusLine } from './dashboard.js';
import { PromptQueue } from './prompt-queue.js';
import { sanitizeTerminal } from './sanitize-terminal.js';
import { formatProxyEvent } from './terminal-output.js';
import {
  ConfigValidationError,
  loadConfig,
  type Config
} from '../config/config.js';
import { appPaths } from '../config/paths.js';
import {
  acquireConfigMutationLock,
  acquireRuntimeLock,
  AlreadyRunningError
} from '../config/runtime-lock.js';
import {
  createEventLogger,
  type EventLogger
} from '../observability/logger.js';
import { KnownHosts } from '../proxy/known-hosts.js';
import { ProxyRuntime } from '../proxy/runtime.js';
import { SshConnection } from '../proxy/ssh-connection.js';

const paths = appPaths();

function configIssueAction(issue: string): string {
  if (/must not be stored/i.test(issue))
    return 'Delete the secret field; enter it only when prompted.';
  if (/localPort|\.port/i.test(issue))
    return 'Use an unused integer port from 1 to 65535.';
  if (/references missing SSH host/i.test(issue))
    return 'Add that SSH host or correct the proxy sshHost name.';
  if (/authentication\.path/i.test(issue))
    return 'Use a readable private-key file with an absolute or ~/ path.';
  if (/unrecognized|unexpected/i.test(issue))
    return 'Remove fields not present in the documented config schema.';
  return 'Correct the value at the reported configuration path.';
}

async function withConfigMutation<T>(action: () => Promise<T>): Promise<T> {
  const lock = await acquireConfigMutationLock(paths.runtime);
  try {
    return await action();
  } finally {
    await lock.release();
  }
}

async function runCheck(config: Config, requestedName?: string): Promise<void> {
  const selected = requestedName
    ? Object.entries(config.proxies).filter(([name]) => name === requestedName)
    : Object.entries(config.proxies);
  if (requestedName && selected.length === 0)
    throw new Error(`Unknown proxy ${requestedName}`);
  if (selected.length === 0) throw new Error('No proxies configured');

  const selectedHosts = new Set(selected.map(([, proxy]) => proxy.sshHost));
  const checkConfig: Config = {
    sshHosts: Object.fromEntries(
      Object.entries(config.sshHosts).filter(([name]) =>
        selectedHosts.has(name)
      )
    ),
    proxies: Object.fromEntries(selected)
  };
  const credentials = await promptCredentials(checkConfig);
  const knownHosts = new KnownHosts(paths.knownHosts);
  const connections = new Map<string, SshConnection>();
  try {
    for (const name of selectedHosts) {
      const host = config.sshHosts[name]!;
      const connection = new SshConnection({
        name,
        config: host,
        knownHosts,
        credentials: credentials.get(name) ?? {},
        confirmUnknownHost: (key) => confirmUnknownHostKey(key),
        confirmChangedHost: confirmChangedHostKey,
        onClose: () => undefined
      });
      connections.set(name, connection);
      process.stdout.write(`Checking SSH ${name}... `);
      await connection.connect();
      console.log('connected');
    }
    for (const [name, proxy] of selected) {
      process.stdout.write(
        `Checking ${name} -> ${proxy.target.host}:${proxy.target.port}... `
      );
      const channel = await connections.get(proxy.sshHost)!.openChannel({
        sourceHost: '127.0.0.1',
        sourcePort: 0,
        targetHost: proxy.target.host,
        targetPort: proxy.target.port
      });
      channel.destroy();
      console.log('reachable');
    }
  } finally {
    for (const connection of connections.values()) connection.close();
  }
}

async function runProxy(
  config: Config,
  noUi: boolean,
  verbose: boolean
): Promise<void> {
  const startedAt = new Date().toISOString();
  const runtimeLock = await acquireRuntimeLock(paths.runtime, {
    pid: process.pid,
    startedAt,
    proxies: Object.keys(config.proxies).length
  });
  try {
    config = await loadConfig(paths.config);
    if (Object.keys(config.proxies).length === 0) {
      throw new Error('No proxies configured. Run pg-ssh-proxy add.');
    }
    await runtimeLock.update({
      pid: process.pid,
      startedAt,
      proxies: Object.keys(config.proxies).length
    });
  } catch (error) {
    await runtimeLock.release();
    throw error;
  }
  const promptController = new AbortController();
  let credentialPromptInterrupted = false;
  const interruptCredentialPrompt = () => {
    credentialPromptInterrupted = true;
    process.exitCode = 130;
    promptController.abort();
  };
  process.on('SIGINT', interruptCredentialPrompt);
  process.on('SIGTERM', interruptCredentialPrompt);
  let credentials;
  try {
    credentials = await promptCredentials(config, promptController.signal);
  } catch (error) {
    await runtimeLock.release();
    if (credentialPromptInterrupted) return;
    throw error;
  } finally {
    process.off('SIGINT', interruptCredentialPrompt);
    process.off('SIGTERM', interruptCredentialPrompt);
  }
  const knownHosts = new KnownHosts(paths.knownHosts);
  let logger: EventLogger;
  try {
    logger = createEventLogger(paths.logs, { size: '5M', rotate: 4 }, (error) =>
      requestShutdown(error)
    );
  } catch (error) {
    await runtimeLock.release();
    throw error;
  }
  const model = new DashboardModel(config);
  const lineMode =
    noUi ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    process.env.TERM === 'dumb' ||
    (Boolean(process.env.CI) && process.env.CI !== 'false');
  let view: Instance | undefined;
  const hostPromptQueue = new PromptQueue();
  let resolveExit: (() => void) | undefined;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  let shuttingDown = false;

  const promptForUnknownHost = (
    key: Parameters<typeof confirmUnknownHostKey>[0],
    isActive: () => boolean
  ) => {
    return hostPromptQueue.run(async () => {
      if (shuttingDown || !isActive()) return false;
      const restoreDashboard = Boolean(view);
      view?.unmount();
      view = undefined;
      const accepted = await confirmUnknownHostKey(
        key,
        promptController.signal
      );
      if (restoreDashboard && !shuttingDown) showDashboard();
      return accepted && !shuttingDown && isActive();
    });
  };

  const runtime = new ProxyRuntime({
    config,
    transportFactory: (name, host, onClose) =>
      new SshConnection({
        name,
        config: host,
        knownHosts,
        credentials: credentials.get(name) ?? {},
        confirmUnknownHost: promptForUnknownHost,
        onClose
      }),
    onStatus: (status) => {
      logger.status(status);
      model.status(status);
      if (lineMode) console.log(formatStatusLine(status, verbose));
    },
    onProxyEvent: (event) => {
      logger.proxyEvent(event);
      model.proxyEvent(event);
      if (lineMode) console.log(formatProxyEvent(event));
    }
  });

  async function shutdown(fatalError?: Error): Promise<void> {
    if (shuttingDown) {
      await runtime.stop(0);
      return;
    }
    shuttingDown = true;
    promptController.abort();
    model.stopping(Date.now() + 10_000, () => runtime.activeConnections);
    if (fatalError) {
      view?.unmount();
      console.error(
        `Runtime failed: ${sanitizeTerminal(fatalError.message)}. Stopping safely.`
      );
    }
    try {
      await runtime.stop(10_000);
    } finally {
      view?.unmount();
      try {
        await logger.close();
      } finally {
        await runtimeLock.release();
        resolveExit?.();
      }
    }
  }

  function requestShutdown(fatalError?: Error): void {
    void shutdown(fatalError).catch(async (error: unknown) => {
      view?.unmount();
      console.error(
        `Forced cleanup failed: ${sanitizeTerminal(error instanceof Error ? error.message : String(error))}`
      );
      process.exitCode = 1;
      try {
        await runtimeLock.release();
      } finally {
        resolveExit?.();
      }
    });
  }

  const onSignal = () => requestShutdown();
  const onFatal = (reason: unknown) => {
    process.exitCode = 1;
    requestShutdown(
      reason instanceof Error ? reason : new Error(String(reason))
    );
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('uncaughtException', onFatal);
  process.on('unhandledRejection', onFatal);

  const showDashboard = (): void => {
    view = render(
      <Dashboard
        model={model}
        onQuit={() => requestShutdown()}
        onRetry={(host) => void runtime.retryNow(host)}
        verbose={verbose}
      />,
      { alternateScreen: true, exitOnCtrlC: false }
    );
  };

  try {
    console.log(
      `Starting ${Object.keys(config.proxies).length} local ${Object.keys(config.proxies).length === 1 ? 'endpoint' : 'endpoints'}...`
    );
    await runtime.start();
    if (shuttingDown) {
      await exited;
      return;
    }
    if (lineMode) {
      console.log('Proxy is running. Press Ctrl+C to stop.');
    } else {
      showDashboard();
    }
    await exited;
  } catch (error) {
    try {
      await runtime.stop(0);
    } finally {
      try {
        await logger.close();
      } finally {
        await runtimeLock.release();
      }
    }
    throw error;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('uncaughtException', onFatal);
    process.off('unhandledRejection', onFatal);
  }
}

async function defaultAction(options: {
  ui: boolean;
  verbose?: boolean;
}): Promise<void> {
  let config: Config;
  try {
    await access(paths.config);
    config = await loadConfig(paths.config);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    console.log(
      `No configuration found at ${paths.config}. Let's create the first proxy.`
    );
    await withConfigMutation(() => addProxy(paths.config));
    config = await loadConfig(paths.config);
  }
  if (Object.keys(config.proxies).length === 0) {
    await withConfigMutation(() => addProxy(paths.config));
    config = await loadConfig(paths.config);
  }
  await runProxy(config, !options.ui, options.verbose ?? false);
}

const program: Command = new Command()
  .name('pg-ssh-proxy')
  .description('Run local PostgreSQL endpoints through SSH')
  .option('--no-ui', 'use line-oriented output instead of fullscreen')
  .option('--verbose', 'show filtered technical error details')
  .showHelpAfterError();

program.action(async (): Promise<void> => {
  await defaultAction(program.opts<{ ui: boolean; verbose?: boolean }>());
});

program
  .command('add')
  .description('add a proxy with an interactive wizard')
  .action(async () => {
    const { before, config } = await withConfigMutation(async () => {
      const before = await loadConfigOrEmpty(paths.config);
      await addProxy(paths.config);
      return { before, config: await loadConfig(paths.config) };
    });
    const added = Object.keys(config.proxies).find(
      (name) => !Object.hasOwn(before.proxies, name)
    );
    console.log(
      '\nTesting the saved route. A failed check does not remove the configuration.'
    );
    await runCheck(config, added);
  });

program
  .command('edit [name]')
  .description('edit a proxy')
  .action(async (name?: string) => {
    const edited = await withConfigMutation(() =>
      editProxy(paths.config, name)
    );
    console.log(
      '\nTesting the saved route. A failed check does not remove the configuration.'
    );
    await runCheck(await loadConfig(paths.config), edited);
  });

program
  .command('remove [name]')
  .description('remove a proxy')
  .action(async (name?: string) => {
    await withConfigMutation(() => removeProxy(paths.config, name));
  });

program
  .command('list')
  .description('show configured routes')
  .action(async () => {
    printConfig(await loadConfigOrEmpty(paths.config));
  });

program
  .command('check [name]')
  .description('test SSH and database reachability')
  .action(async (name?: string) => {
    await runCheck(await loadConfig(paths.config), name);
  });

const configCommand = program
  .command('config')
  .description('inspect configuration');
configCommand
  .command('path')
  .description('show the configuration path')
  .action(() => console.log(paths.config));
configCommand
  .command('validate')
  .description('validate the whole configuration')
  .action(async () => {
    const config = await loadConfig(paths.config);
    console.log(
      `Valid configuration: ${Object.keys(config.sshHosts).length} SSH hosts, ${Object.keys(config.proxies).length} proxies`
    );
  });

program.parseAsync().catch((error: unknown) => {
  if (error instanceof UserCancelledError) {
    console.error(error.message);
  } else if (error instanceof AlreadyRunningError) {
    const detail = error.metadata
      ? `PID ${error.metadata.pid}, ${error.metadata.proxies} proxies, started ${error.metadata.startedAt}`
      : 'another process owns the runtime lock';
    console.error(`pg-ssh-proxy is already running (${detail}).`);
  } else if (error instanceof ConfigValidationError) {
    console.error('Invalid configuration:');
    for (const issue of error.issues) {
      console.error(`- ${sanitizeTerminal(issue)}`);
      console.error(`  Next: ${configIssueAction(issue)}`);
    }
    console.error(`Then run: pg-ssh-proxy config validate`);
  } else {
    console.error(
      sanitizeTerminal(error instanceof Error ? error.message : String(error))
    );
    if (
      program.opts<{ verbose?: boolean }>().verbose &&
      error instanceof Error
    ) {
      const code = (error as NodeJS.ErrnoException).code;
      console.error(
        `Details: type=${error.name}${code ? ` code=${code}` : ''}`
      );
    }
  }
  process.exitCode = 1;
});
