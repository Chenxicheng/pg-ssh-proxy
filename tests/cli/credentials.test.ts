import { describe, expect, it, vi } from 'vitest';

const promptMocks = vi.hoisted(() => ({ confirm: vi.fn() }));

vi.mock('@inquirer/prompts', () => ({
  confirm: promptMocks.confirm,
  input: vi.fn(),
  password: vi.fn()
}));

import {
  confirmUnknownHostKey,
  validatePrivateKey
} from '../../src/cli/credentials.js';

describe('SSH private key validation', () => {
  it('rejects malformed keys before runtime retry begins', () => {
    expect(validatePrivateKey(Buffer.from('not-a-private-key'))).toBeInstanceOf(
      Error
    );
  });

  it('passes the runtime abort signal to host-key confirmation', async () => {
    promptMocks.confirm.mockResolvedValueOnce(false);
    const controller = new AbortController();

    await confirmUnknownHostKey(
      {
        host: 'bastion.example.com',
        port: 22,
        keyType: 'ssh-ed25519',
        fingerprint: 'SHA256:test'
      },
      controller.signal
    );

    expect(promptMocks.confirm).toHaveBeenCalledWith(expect.any(Object), {
      signal: controller.signal
    });
  });
});
