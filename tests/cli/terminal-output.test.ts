import { describe, expect, it } from 'vitest';

import { formatProxyEvent } from '../../src/cli/terminal-output.js';

describe('line-mode output', () => {
  it('shows lifecycle metadata without database payloads', () => {
    expect(
      formatProxyEvent({
        type: 'close',
        connectionId: 'abc-123',
        proxy: 'orders-db',
        elapsedMs: 1250,
        bytesFromClient: 32,
        bytesToClient: 64,
        reason: 'client closed',
        at: 0
      })
    ).toBe(
      '[CLOSE] orders-db abc-123 · client closed · 1250ms · 32B up · 64B down'
    );
  });
});
