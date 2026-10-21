import { describe, expect, it } from 'vitest';

import { PromptQueue } from '../../src/cli/prompt-queue.js';

describe('interactive prompt queue', () => {
  it('never displays two host fingerprint prompts at once', async () => {
    const queue = new PromptQueue();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;

    const first = queue.run(
      () =>
        new Promise<string>((resolve) => {
          order.push('first-start');
          releaseFirst = () => {
            order.push('first-end');
            resolve('first');
          };
        })
    );
    const second = queue.run(async () => {
      order.push('second-start');
      return 'second';
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['first-start']);

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });
});
