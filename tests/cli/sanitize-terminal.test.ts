import { describe, expect, it } from 'vitest';

import { sanitizeTerminal } from '../../src/cli/sanitize-terminal.js';

describe('terminal output boundary', () => {
  it('removes control sequences and bounds remote text', () => {
    expect(
      sanitizeTerminal(`failed\u001b]0;owned\u0007${'x'.repeat(300)}`)
    ).toBe(`failed ]0;owned ${'x'.repeat(184)}`);
  });
});
