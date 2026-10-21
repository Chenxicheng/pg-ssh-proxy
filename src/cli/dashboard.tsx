import React, {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore
} from 'react';
import { Box, Text, useInput } from 'ink';

import type { Config } from '../config/config.js';
import type { ProxyEvent } from '../proxy/local-proxy.js';
import type { RuntimeStatus } from '../proxy/runtime.js';
import { sanitizeTerminal } from './sanitize-terminal.js';

interface ProxyView {
  name: string;
  localPort: number;
  sshHost: string;
  target: string;
  status: RuntimeStatus['status'];
  error?: string;
  errorCode?: string;
  retryAt?: number;
  attempt?: number;
  elapsedMs?: number;
}

interface DashboardSnapshot {
  proxies: ProxyView[];
  events: ProxyEvent[];
}

export class DashboardModel {
  readonly #config: Config;
  readonly #statuses = new Map<string, RuntimeStatus>();
  readonly #retryAt = new Map<string, number>();
  readonly #events: ProxyEvent[] = [];
  readonly #listeners = new Set<() => void>();
  #shutdown: { deadline: number; activeConnections: () => number } | undefined;
  #snapshot: DashboardSnapshot;

  constructor(config: Config) {
    this.#config = config;
    this.#snapshot = this.#buildSnapshot();
  }

  status(status: RuntimeStatus): void {
    this.#statuses.set(status.host, status);
    if (status.status === 'retrying') {
      this.#retryAt.set(status.host, Date.now() + status.retryInMs);
    } else {
      this.#retryAt.delete(status.host);
    }
    this.#publish();
  }

  proxyEvent(event: ProxyEvent): void {
    this.#events.push(event);
    if (this.#events.length > 500) {
      this.#events.splice(0, this.#events.length - 500);
    }
    this.#publish();
  }

  stopping(deadline: number, activeConnections: () => number): void {
    this.#shutdown = { deadline, activeConnections };
    this.#publish();
  }

  shutdownState(): { deadline: number; activeConnections: number } | undefined {
    return this.#shutdown
      ? {
          deadline: this.#shutdown.deadline,
          activeConnections: this.#shutdown.activeConnections()
        }
      : undefined;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  snapshot = (): DashboardSnapshot => this.#snapshot;

  #publish(): void {
    this.#snapshot = this.#buildSnapshot();
    for (const listener of this.#listeners) listener();
  }

  #buildSnapshot(): DashboardSnapshot {
    return {
      proxies: Object.entries(this.#config.proxies).map(([name, proxy]) => {
        const status = this.#statuses.get(proxy.sshHost);
        const retryAt = this.#retryAt.get(proxy.sshHost);
        return {
          name,
          localPort: proxy.localPort,
          sshHost: proxy.sshHost,
          target: `${proxy.target.host}:${proxy.target.port}`,
          status: status?.status ?? 'starting',
          ...(status && 'error' in status && status.error
            ? { error: status.error }
            : {}),
          ...(status && 'errorCode' in status && status.errorCode
            ? { errorCode: status.errorCode }
            : {}),
          ...(retryAt ? { retryAt } : {}),
          ...(status?.status === 'retrying'
            ? { attempt: status.attempt, elapsedMs: status.elapsedMs }
            : {})
        };
      }),
      events: [...this.#events].reverse()
    };
  }
}

function statusColor(
  status: RuntimeStatus['status']
): 'green' | 'yellow' | 'red' | 'cyan' {
  if (status === 'ready') return 'green';
  if (status === 'retrying') return 'yellow';
  if (status === 'unavailable') return 'red';
  return 'cyan';
}

function eventLabel(event: ProxyEvent): string {
  if (event.type === 'request') return 'REQ';
  if (event.type === 'response') return 'RES';
  return 'CLOSE';
}

function eventSummary(event: ProxyEvent): string {
  if (event.type === 'request') return sanitizeTerminal(event.client);
  if (event.type === 'response') {
    return event.status === 'connected'
      ? `connected ${event.elapsedMs}ms`
      : `${sanitizeTerminal(event.error ?? 'failed')}${event.errorCode ? ` [${event.errorCode}]` : ''}`;
  }
  return `${sanitizeTerminal(event.reason)}${event.errorCode ? ` [${event.errorCode}]` : ''} · ${event.elapsedMs}ms · ${event.bytesFromClient}B ↑ · ${event.bytesToClient}B ↓`;
}

export function formatStatusLine(
  status: RuntimeStatus,
  verbose = false
): string {
  const prefix = `[${status.status.toUpperCase()}] ${status.host}`;
  if (status.status === 'retrying') {
    const detail = verbose
      ? ` · phase=${status.phase} · attempt=${status.attempt} · elapsed=${status.elapsedMs}ms${status.errorCode ? ` · code=${status.errorCode}` : ''}`
      : '';
    return `${prefix} · ${sanitizeTerminal(status.error)} · retry in ${Math.ceil(status.retryInMs / 1000)}s${detail}`;
  }
  if (status.status === 'unavailable') {
    const detail = verbose
      ? ` · phase=${status.phase}${status.errorCode ? ` · code=${status.errorCode}` : ''}`
      : '';
    return `${prefix} · ${sanitizeTerminal(status.error)} · action required${detail}`;
  }
  return prefix;
}

export interface DashboardProps {
  model: DashboardModel;
  onQuit: () => void;
  onRetry: (host: string) => void;
  verbose?: boolean;
}

export function Dashboard({
  model,
  onQuit,
  onRetry,
  verbose = false
}: DashboardProps): React.JSX.Element {
  const live = useSyncExternalStore(
    model.subscribe,
    model.snapshot,
    model.snapshot
  );
  const [frozenEvents, setFrozenEvents] = useState<ProxyEvent[]>();
  const [selected, setSelected] = useState(0);
  const [filter, setFilter] = useState('');
  const [editingFilter, setEditingFilter] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const eventsSnapshot = frozenEvents ?? live.events;
  const events = useMemo(() => {
    const value = filter.toLowerCase();
    if (!value) return eventsSnapshot;
    return eventsSnapshot.filter((event) =>
      `${event.proxy} ${event.connectionId} ${event.type} ${eventSummary(event)}`
        .toLowerCase()
        .includes(value)
    );
  }, [eventsSnapshot, filter]);
  const selectedEvent = events[Math.min(selected, events.length - 1)];
  const shutdown = model.shutdownState();

  useEffect(() => {
    if (!shutdown && !live.proxies.some((proxy) => proxy.retryAt)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live.proxies, shutdown]);

  useInput((input, key) => {
    if (editingFilter) {
      if (key.return || key.escape) {
        setEditingFilter(false);
      } else if (key.backspace || key.delete) {
        setFilter((value) => value.slice(0, -1));
      } else if (!key.ctrl && !key.meta && input) {
        setFilter((value) => value + input);
      }
      return;
    }
    if (input === 'q' || (key.ctrl && input === 'c')) {
      onQuit();
    } else if (input === 'r') {
      const hosts = new Set(
        live.proxies
          .filter((proxy) => proxy.status !== 'ready')
          .map((proxy) => proxy.sshHost)
      );
      for (const host of hosts) onRetry(host);
    } else if (input === '/') {
      setEditingFilter(true);
    } else if (input === ' ') {
      setFrozenEvents((value) => (value ? undefined : live.events));
    } else if (input === '?') {
      setShowHelp((value) => !value);
    } else if (key.upArrow) {
      setSelected((value) => Math.max(0, value - 1));
    } else if (key.downArrow) {
      setSelected((value) => Math.min(events.length - 1, value + 1));
    }
  });

  return (
    <Box flexDirection="column" height="100%">
      <Box justifyContent="space-between" borderStyle="single">
        <Text bold> pg-ssh-proxy </Text>
        <Text>
          {live.proxies.filter((proxy) => proxy.status === 'ready').length}{' '}
          ready · {live.proxies.length} total{' '}
        </Text>
      </Box>
      <Box flexGrow={1}>
        <Box
          width="25%"
          flexDirection="column"
          borderStyle="single"
          borderTop={false}
        >
          <Text dimColor> PROXIES</Text>
          {live.proxies.map((proxy) => (
            <Box key={proxy.name} flexDirection="column" marginTop={1}>
              <Text color={statusColor(proxy.status)}>
                ● {proxy.name} {proxy.status}
              </Text>
              <Text dimColor> 127.0.0.1:{proxy.localPort}</Text>
              {proxy.retryAt ? (
                <Text color="yellow">
                  {' '}
                  retry in{' '}
                  {Math.max(0, Math.ceil((proxy.retryAt - now) / 1000))}s
                </Text>
              ) : null}
              {proxy.error ? (
                <Text color="red"> {sanitizeTerminal(proxy.error)}</Text>
              ) : null}
              {verbose && proxy.attempt ? (
                <Text dimColor>
                  {' '}
                  phase=ssh_connect · attempt={proxy.attempt} · elapsed=
                  {proxy.elapsedMs}ms
                  {proxy.errorCode ? ` · code=${proxy.errorCode}` : ''}
                </Text>
              ) : null}
            </Box>
          ))}
        </Box>
        <Box
          width="45%"
          flexDirection="column"
          borderStyle="single"
          borderTop={false}
          borderLeft={false}
        >
          <Text dimColor>
            {' '}
            LIVE CONNECTIONS {frozenEvents ? '· paused' : '· follow on'}
          </Text>
          {editingFilter || filter ? (
            <Text color="cyan"> / {filter || 'type to filter'}</Text>
          ) : null}
          {events.slice(0, 15).map((event, index) => (
            <Text
              key={`${event.connectionId}-${event.type}`}
              inverse={index === selected}
              wrap="truncate"
            >
              {eventLabel(event).padEnd(5)} {event.proxy.padEnd(16)}{' '}
              {eventSummary(event)}
            </Text>
          ))}
        </Box>
        <Box
          width="30%"
          flexDirection="column"
          borderStyle="single"
          borderTop={false}
          borderLeft={false}
        >
          <Text dimColor> CONNECTION DETAIL</Text>
          {selectedEvent ? (
            <>
              <Text> ID {selectedEvent.connectionId}</Text>
              <Text> Proxy {selectedEvent.proxy}</Text>
              <Text> Event {eventLabel(selectedEvent)}</Text>
              <Text> Result {eventSummary(selectedEvent)}</Text>
              <Text dimColor>
                {' '}
                Payload hidden: SQL, credentials and rows are never displayed.
              </Text>
            </>
          ) : (
            <Text dimColor> No matching connection events</Text>
          )}
        </Box>
      </Box>
      <Box borderStyle="single" borderTop={false}>
        {shutdown ? (
          <Text color="yellow">
            Stopping · {shutdown.activeConnections} active · force close in{' '}
            {Math.max(0, Math.ceil((shutdown.deadline - now) / 1000))}s · press
            q again to force
          </Text>
        ) : (
          <Text dimColor>
            ↑↓ select · / filter · space pause · r retry · ? help · q quit
          </Text>
        )}
      </Box>
      {showHelp ? (
        <Box borderStyle="round" flexDirection="column">
          <Text bold>Keyboard help</Text>
          <Text>Enter detail · / filter · Space pause · r retry · q quit</Text>
        </Box>
      ) : null}
    </Box>
  );
}
