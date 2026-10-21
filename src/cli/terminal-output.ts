import type { ProxyEvent } from '../proxy/local-proxy.js';
import { sanitizeTerminal } from './sanitize-terminal.js';

export function formatProxyEvent(event: ProxyEvent): string {
  const prefix = `${event.proxy} ${event.connectionId}`;
  if (event.type === 'request')
    return `[REQ] ${prefix} · ${sanitizeTerminal(event.client)}`;
  if (event.type === 'response') {
    return `[RES] ${prefix} · ${event.status} · ${event.elapsedMs}ms${event.error ? ` · ${sanitizeTerminal(event.error)}` : ''}`;
  }
  return `[CLOSE] ${prefix} · ${sanitizeTerminal(event.reason)} · ${event.elapsedMs}ms · ${event.bytesFromClient}B up · ${event.bytesToClient}B down`;
}
