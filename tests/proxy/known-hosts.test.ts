import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fingerprint, KnownHosts } from '../../src/proxy/known-hosts.js';

describe('SSH host identity seam', () => {
  it('distinguishes unknown, trusted and changed keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pg-ssh-proxy-hosts-'));
    const path = join(root, 'known_hosts');
    const knownHosts = new KnownHosts(path);
    const firstKey = Buffer.from('first-key');
    const changedKey = Buffer.from('changed-key');

    await expect(
      knownHosts.check('bastion.example.com', 22, firstKey)
    ).resolves.toMatchObject({ status: 'unknown' });

    await knownHosts.trust('bastion.example.com', 22, 'ssh-ed25519', firstKey);

    await expect(
      knownHosts.check('bastion.example.com', 22, firstKey)
    ).resolves.toMatchObject({ status: 'trusted' });
    await expect(
      knownHosts.check('bastion.example.com', 22, changedKey)
    ).resolves.toMatchObject({
      status: 'changed',
      previousFingerprint: expect.stringMatching(/^SHA256:/),
      fingerprint: expect.stringMatching(/^SHA256:/)
    });
  });

  it('replaces only the selected host identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pg-ssh-proxy-hosts-'));
    const path = join(root, 'known_hosts');
    const knownHosts = new KnownHosts(path);
    await knownHosts.trust(
      'first.example.com',
      22,
      'ssh-ed25519',
      Buffer.from('a')
    );
    await knownHosts.trust(
      'second.example.com',
      2222,
      'ssh-rsa',
      Buffer.from('b')
    );

    await knownHosts.replace(
      'first.example.com',
      22,
      'ssh-ed25519',
      Buffer.from('replacement'),
      fingerprint(Buffer.from('a'))
    );

    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('first.example.com');
    expect(lines[0]).toContain(Buffer.from('replacement').toString('base64'));
    expect(lines[1]).toContain('[second.example.com]:2222');
  });

  it('does not lose host identities confirmed concurrently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pg-ssh-proxy-hosts-'));
    const path = join(root, 'known_hosts');
    const knownHosts = new KnownHosts(path);

    await Promise.all([
      knownHosts.trust(
        'first.example.com',
        22,
        'ssh-ed25519',
        Buffer.from('a')
      ),
      knownHosts.trust(
        'second.example.com',
        22,
        'ssh-ed25519',
        Buffer.from('b')
      )
    ]);

    const contents = await readFile(path, 'utf8');
    expect(contents).toContain('first.example.com');
    expect(contents).toContain('second.example.com');
  });

  it('never replaces a concurrently trusted key without explicit approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pg-ssh-proxy-hosts-'));
    const path = join(root, 'known_hosts');
    const knownHosts = new KnownHosts(path);
    const keys = [Buffer.from('first-key'), Buffer.from('second-key')];

    const results = await Promise.allSettled(
      keys.map((key) =>
        knownHosts.trust('shared.example.com', 22, 'ssh-ed25519', key)
      )
    );

    expect(
      results.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected')
    ).toHaveLength(1);
    const contents = await readFile(path, 'utf8');
    expect(
      keys.filter((key) => contents.includes(key.toString('base64')))
    ).toHaveLength(1);
  });

  it('rejects a replacement confirmed against a stale host identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pg-ssh-proxy-hosts-'));
    const path = join(root, 'known_hosts');
    const knownHosts = new KnownHosts(path);
    const original = Buffer.from('original');
    const originalFingerprint = fingerprint(original);
    const firstReplacement = Buffer.from('first-replacement');
    await knownHosts.trust('shared.example.com', 22, 'ssh-ed25519', original);

    await knownHosts.replace(
      'shared.example.com',
      22,
      'ssh-ed25519',
      firstReplacement,
      originalFingerprint
    );
    await expect(
      knownHosts.replace(
        'shared.example.com',
        22,
        'ssh-ed25519',
        Buffer.from('stale-replacement'),
        originalFingerprint
      )
    ).rejects.toThrow('changed after confirmation');
    await expect(
      knownHosts.check('shared.example.com', 22, firstReplacement)
    ).resolves.toMatchObject({ status: 'trusted' });
  });
});
