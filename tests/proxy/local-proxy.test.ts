import { connect } from 'node:net';
import { Transform } from 'node:stream';
import { once } from 'node:events';

import { describe, expect, it } from 'vitest';

import { LocalProxy, type ProxyEvent } from '../../src/proxy/local-proxy.js';

describe('local TCP to SSH channel seam', () => {
  it('forwards bytes in both directions and emits connection lifecycle events', async () => {
    const events: ProxyEvent[] = [];
    const proxy = new LocalProxy({
      name: 'orders-db',
      localPort: 0,
      target: { host: 'postgres.internal', port: 5432 },
      openChannel: async () =>
        new Transform({
          transform(chunk, _encoding, callback) {
            callback(null, chunk);
          }
        }),
      onEvent: (event) => events.push(event)
    });
    await proxy.start();

    const client = connect({
      host: '127.0.0.1',
      port: proxy.localPort
    });
    await once(client, 'connect');
    client.write('select 1');
    const [response] = (await once(client, 'data')) as [Buffer];
    client.end();
    await once(client, 'close');
    await proxy.stop(100);

    expect(response.toString()).toBe('select 1');
    expect(events.map((event) => event.type)).toEqual([
      'request',
      'response',
      'close'
    ]);
    expect(events[1]).toMatchObject({
      type: 'response',
      proxy: 'orders-db',
      status: 'connected'
    });
    expect(events[2]).toMatchObject({
      type: 'close',
      bytesFromClient: 8,
      bytesToClient: 8
    });
  });

  it('closes the local connection when opening the SSH channel fails', async () => {
    const events: ProxyEvent[] = [];
    const proxy = new LocalProxy({
      name: 'billing-db',
      localPort: 0,
      target: { host: 'billing.internal', port: 5432 },
      openChannel: async () => {
        throw new Error('SSH unavailable');
      },
      onEvent: (event) => events.push(event)
    });
    await proxy.start();

    const client = connect({
      host: '127.0.0.1',
      port: proxy.localPort
    });
    await once(client, 'close');
    await proxy.stop(100);

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: 'response',
      status: 'failed',
      error: 'SSH unavailable'
    });
  });
});
