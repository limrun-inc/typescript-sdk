import fs from 'fs';
import os from 'os';
import path from 'path';

import { type IosInstance } from '@limrun/api/resources/ios-instances';
import { GLOBAL_SCOPE_KEY } from '../packages/cli/src/lib/scope';

interface ConfigTestContext {
  homeDir: string;
  configFile: string;
  /** Switch the active directory scope for subsequent config calls. */
  setScope: (key: string) => void;
}

const DEFAULT_TEST_SCOPE = '/limrun-test-scope-default';

async function withConfigModule<T>(
  fn: (config: typeof import('../packages/cli/src/lib/config'), ctx: ConfigTestContext) => T,
): Promise<T> {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'limrun-cli-config-test-'));
  const homedir = () => homeDir;
  const previousScope = process.env['LIM_WORKSPACE'];
  process.env['LIM_WORKSPACE'] = DEFAULT_TEST_SCOPE;
  jest.resetModules();
  jest.doMock('os', () => {
    const actual = jest.requireActual<typeof import('os')>('os');
    return { ...actual, homedir, default: { ...actual, homedir } };
  });

  try {
    const config = await import('../packages/cli/src/lib/config');
    const ctx: ConfigTestContext = {
      homeDir,
      configFile: path.join(homeDir, '.lim', 'last-instances.json'),
      setScope: (key: string) => {
        process.env['LIM_WORKSPACE'] = key;
      },
    };
    return fn(config, ctx);
  } finally {
    if (previousScope === undefined) {
      delete process.env['LIM_WORKSPACE'];
    } else {
      process.env['LIM_WORKSPACE'] = previousScope;
    }
    jest.dontMock('os');
    jest.resetModules();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

function iosInstanceWithId(id: string): IosInstance {
  const base = iosInstanceWithXcodeUrl();
  return { ...base, metadata: { ...base.metadata, id } };
}

function iosInstanceWithXcodeUrl(url?: string): IosInstance {
  return {
    metadata: {
      id: 'ios_euna_01test',
      createdAt: '2026-05-29T00:00:00Z',
      organizationId: 'org_123',
      displayName: 'Sample app session',
    },
    spec: {
      region: 'eu-north-1',
      inactivityTimeout: '3m',
      hardTimeout: '30m',
    },
    status: {
      state: 'ready',
      apiUrl: 'https://ios.example.test',
      token: 'lim_ios_token',
      ...(url ? { sandbox: { xcode: { url } } } : {}),
    },
  };
}

describe('CLI last instance config', () => {
  test('registers the real sandbox Xcode target for iOS-owned Xcode sandboxes', async () => {
    await withConfigModule((config) => {
      const xcodeUrl = 'https://instances.example.test/sandbox_01xcode/api';
      config.registerCreatedInstance(iosInstanceWithXcodeUrl(xcodeUrl), ['xcode']);

      expect(config.loadLastIosInstance()).toMatchObject({
        id: 'ios_euna_01test',
        type: 'ios',
      });
      expect(config.loadLastXcodeInstance()).toMatchObject({
        id: 'sandbox_01xcode',
        type: 'xcode',
        apiUrl: xcodeUrl,
        token: 'lim_ios_token',
        metadata: {
          id: 'sandbox_01xcode',
          createdAt: '2026-05-29T00:00:00Z',
          organizationId: 'org_123',
          displayName: 'Sample app session',
        },
        spec: {
          region: 'eu-north-1',
          inactivityTimeout: '3m',
          hardTimeout: '30m',
        },
        status: {
          state: 'ready',
          apiUrl: xcodeUrl,
          token: 'lim_ios_token',
        },
      });
    });
  });

  test('clears the derived sandbox Xcode target when the owning iOS instance is cleared', async () => {
    await withConfigModule((config) => {
      config.registerCreatedInstance(
        iosInstanceWithXcodeUrl('https://instances.example.test/sandbox_01xcode/api'),
        ['xcode'],
      );

      config.clearLastInstanceId('ios_euna_01test');

      expect(config.loadLastIosInstance()).toBeNull();
      expect(config.loadLastXcodeInstance()).toBeNull();
    });
  });

  test('keeps legacy iOS xcode slot behavior when no sandbox URL is available', async () => {
    await withConfigModule((config) => {
      config.registerCreatedInstance(iosInstanceWithXcodeUrl(), ['xcode']);

      expect(config.loadLastXcodeInstance()).toMatchObject({
        id: 'ios_euna_01test',
        type: 'ios',
      });
    });
  });

  test('keeps legacy iOS xcode slot behavior when sandbox URL cannot be parsed', async () => {
    await withConfigModule((config) => {
      config.registerCreatedInstance(
        iosInstanceWithXcodeUrl('https://instances.example.test/no-sandbox-id'),
        ['xcode'],
      );

      expect(config.loadLastXcodeInstance()).toMatchObject({
        id: 'ios_euna_01test',
        type: 'ios',
      });
    });
  });

  test('isolates the last instance per directory scope', async () => {
    await withConfigModule((config, ctx) => {
      ctx.setScope('/work/worktree-a');
      config.registerCreatedInstance(iosInstanceWithId('ios_euna_01aaaa'));

      ctx.setScope('/work/worktree-b');
      config.registerCreatedInstance(iosInstanceWithId('ios_euna_01bbbb'));

      ctx.setScope('/work/worktree-a');
      expect(config.loadLastIosInstance()).toMatchObject({ id: 'ios_euna_01aaaa' });

      ctx.setScope('/work/worktree-b');
      expect(config.loadLastIosInstance()).toMatchObject({ id: 'ios_euna_01bbbb' });

      ctx.setScope('/work/worktree-c');
      expect(config.loadLastIosInstance()).toBeNull();
    });
  });

  test('does not leak the last instance across unrelated directory scopes', async () => {
    await withConfigModule((config, ctx) => {
      ctx.setScope('/work/worktree-a');
      config.registerCreatedInstance(iosInstanceWithId('ios_euna_01aaaa'));

      ctx.setScope('/work/worktree-b');
      expect(config.loadLastIosInstance()).toBeNull();
    });
  });

  test('clearLastInstanceId removes the instance from every scope', async () => {
    await withConfigModule((config, ctx) => {
      ctx.setScope('/work/worktree-a');
      config.registerCreatedInstance(iosInstanceWithId('ios_euna_01shared'));
      ctx.setScope('/work/worktree-b');
      config.registerCreatedInstance(iosInstanceWithId('ios_euna_01shared'));

      config.clearLastInstanceId('ios_euna_01shared');

      ctx.setScope('/work/worktree-a');
      expect(config.loadLastIosInstance()).toBeNull();
      ctx.setScope('/work/worktree-b');
      expect(config.loadLastIosInstance()).toBeNull();
    });
  });

  test('by-id cache lookups resolve across scopes', async () => {
    await withConfigModule((config, ctx) => {
      ctx.setScope('/work/worktree-a');
      config.registerCreatedInstance(iosInstanceWithId('ios_euna_01aaaa'));

      // From a different scope, an explicit --id should still find the cached record.
      ctx.setScope('/work/worktree-b');
      expect(config.loadIosInstanceCache('ios_euna_01aaaa')).toMatchObject({
        id: 'ios_euna_01aaaa',
        type: 'ios',
        apiUrl: 'https://ios.example.test',
        token: 'lim_ios_token',
      });
    });
  });

  test('migrates a legacy flat last-instances file into the active scope', async () => {
    await withConfigModule((config, ctx) => {
      fs.mkdirSync(path.dirname(ctx.configFile), { recursive: true });
      fs.writeFileSync(
        ctx.configFile,
        JSON.stringify({
          ios: { id: 'ios_euna_01legacy', type: 'ios', apiUrl: 'https://ios.example.test' },
        }),
      );

      ctx.setScope('/work/first-dir');
      // Reads bridge the legacy data so it is usable out of the box.
      expect(config.loadLastIosInstance()).toMatchObject({ id: 'ios_euna_01legacy' });

      // A write migrates the legacy data into the active scope and rewrites the file.
      config.registerCreatedInstance(iosInstanceWithId('ios_euna_01new'));

      const persisted = JSON.parse(fs.readFileSync(ctx.configFile, 'utf-8'));
      expect(persisted.version).toBe(2);
      expect(persisted.ios).toBeUndefined();
      expect(persisted.scopes['/work/first-dir'].ios).toMatchObject({ id: 'ios_euna_01new' });

      // The legacy bridge no longer applies to other scopes once migrated.
      ctx.setScope('/work/other-dir');
      expect(config.loadLastIosInstance()).toBeNull();
    });
  });

  test('keeps the global (non-repo) slot but prunes stale directory scopes', async () => {
    await withConfigModule((config, ctx) => {
      const stale = new Date('2000-01-01T00:00:00Z').toISOString();
      fs.mkdirSync(path.dirname(ctx.configFile), { recursive: true });
      fs.writeFileSync(
        ctx.configFile,
        JSON.stringify({
          version: 2,
          scopes: {
            [GLOBAL_SCOPE_KEY]: {
              lastUsedAt: stale,
              ios: { id: 'ios_euna_01global', type: 'ios' },
            },
            '/work/stale-dir': {
              lastUsedAt: stale,
              ios: { id: 'ios_euna_01stale', type: 'ios' },
            },
          },
        }),
      );

      // Any write triggers pruning.
      ctx.setScope('/work/fresh-dir');
      config.registerCreatedInstance(iosInstanceWithId('ios_euna_01fresh'));

      const persisted = JSON.parse(fs.readFileSync(ctx.configFile, 'utf-8'));
      // Global slot survives despite being long stale.
      expect(persisted.scopes[GLOBAL_SCOPE_KEY].ios).toMatchObject({ id: 'ios_euna_01global' });
      // A stale directory scope is pruned.
      expect(persisted.scopes['/work/stale-dir']).toBeUndefined();
      // The fresh scope we just wrote is kept.
      expect(persisted.scopes['/work/fresh-dir'].ios).toMatchObject({ id: 'ios_euna_01fresh' });
    });
  });
});
