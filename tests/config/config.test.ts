import { access, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ConfigValidationError,
  loadConfig,
  saveConfig,
  validateConfig
} from '../../src/config/config.js';

const validConfig = {
  sshHosts: {
    production: {
      host: 'bastion.example.com',
      port: 22,
      username: 'deploy',
      authentication: { type: 'agent' }
    }
  },
  proxies: {
    'orders-db': {
      localPort: 15432,
      sshHost: 'production',
      target: {
        host: 'postgres.internal',
        port: 5432
      }
    }
  }
};

describe('configuration contract', () => {
  it('accepts the documented configuration', () => {
    expect(validateConfig(validConfig)).toEqual(validConfig);
  });

  it('reports all structural, reference, port and secret errors together', () => {
    const result = {
      sshHosts: {
        Production: {
          host: '',
          port: 70000,
          username: 'deploy',
          authentication: {
            type: 'password',
            password: 'must-not-be-stored'
          }
        }
      },
      proxies: {
        first: {
          localPort: 15432,
          sshHost: 'missing',
          target: { host: 'db.internal', port: 5432 }
        },
        second: {
          localPort: 15432,
          sshHost: 'missing',
          target: { host: 'db.internal', port: 5432 }
        }
      },
      unexpected: true
    };

    expect(() => validateConfig(result)).toThrow(ConfigValidationError);

    try {
      validateConfig(result);
    } catch (error) {
      const issues = (error as ConfigValidationError).issues.join('\n');
      expect(issues).toContain('sshHosts.Production');
      expect(issues).toContain('authentication.password');
      expect(issues).toContain('proxies.first.sshHost');
      expect(issues).toContain('proxies.second.localPort');
      expect(issues).toContain('unexpected');
    }
  });

  it('allows the same target through different local ports and SSH hosts', () => {
    const config = {
      sshHosts: {
        ...validConfig.sshHosts,
        staging: {
          host: 'staging.example.com',
          port: 22,
          username: 'deploy',
          authentication: { type: 'agent' }
        }
      },
      proxies: {
        ...validConfig.proxies,
        'orders-staging': {
          localPort: 15433,
          sshHost: 'staging',
          target: {
            host: 'postgres.internal',
            port: 5432
          }
        }
      }
    };

    expect(validateConfig(config)).toEqual(config);
  });

  it('does not treat inherited object properties as SSH host references', () => {
    expect(() =>
      validateConfig({
        sshHosts: {},
        proxies: {
          postgres: {
            localPort: 15432,
            sshHost: 'constructor',
            target: { host: 'db.internal', port: 5432 }
          }
        }
      })
    ).toThrow('references missing SSH host "constructor"');
  });

  it('rejects terminal control characters in user-visible fields', () => {
    expect(() =>
      validateConfig({
        ...validConfig,
        sshHosts: {
          production: {
            ...validConfig.sshHosts.production,
            host: 'bastion.example.com\u001b]0;owned\u0007'
          }
        }
      })
    ).toThrow('must not contain control characters');
  });

  it('loads a readable identity file and expands ~/', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pg-ssh-proxy-config-'));
    const identityPath = join(root, 'id_ed25519');
    const configPath = join(root, 'config.json');
    await writeFile(identityPath, 'private-key-placeholder', { mode: 0o600 });
    await writeFile(
      configPath,
      JSON.stringify({
        ...validConfig,
        sshHosts: {
          production: {
            ...validConfig.sshHosts.production,
            authentication: {
              type: 'identityFile',
              path: '~/id_ed25519'
            }
          }
        }
      })
    );

    const config = await loadConfig(configPath, root);

    expect(config.sshHosts.production?.authentication).toEqual({
      type: 'identityFile',
      path: identityPath
    });
  });

  it('atomically saves a private config file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pg-ssh-proxy-save-'));
    const configPath = join(root, 'config.json');

    await saveConfig(validConfig, configPath);

    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual(validConfig);
    if (process.platform !== 'win32') {
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
      expect((await stat(root)).mode & 0o777).toBe(0o700);
    }
  });

  it('refuses to save an unreadable identity file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pg-ssh-proxy-save-'));
    const configPath = join(root, 'config.json');

    await expect(
      saveConfig(
        {
          ...validConfig,
          sshHosts: {
            production: {
              ...validConfig.sshHosts.production,
              authentication: {
                type: 'identityFile',
                path: '~/missing-key'
              }
            }
          }
        },
        configPath,
        root
      )
    ).rejects.toThrow('is not a readable file');
    await expect(access(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports structural and identity-file errors in one validation pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pg-ssh-proxy-validate-'));
    const configPath = join(root, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        sshHosts: {
          production: {
            host: 'bastion.example.com',
            port: 22,
            username: 'deploy',
            authentication: {
              type: 'identityFile',
              path: '~/missing-key'
            }
          }
        },
        proxies: {
          postgres: {
            localPort: 0,
            sshHost: 'production',
            target: { host: 'db.internal', port: 5432 }
          }
        }
      })
    );

    try {
      await loadConfig(configPath, root);
      throw new Error('Expected loadConfig to fail');
    } catch (error) {
      const issues = (error as ConfigValidationError).issues.join('\n');
      expect(issues).toContain('proxies.postgres.localPort');
      expect(issues).toContain('missing-key');
    }
  });
});
