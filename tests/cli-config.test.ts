import fs from 'fs';
import os from 'os';
import path from 'path';

import { type IosInstance } from '@limrun/api/resources/ios-instances';

interface ConfigTestContext {
  homeDir: string;
  configFile: string;
  /** Switch the active directory scope for subsequent config calls. */
  setScope: (key: string) => void;
}

const DEFAULT_TEST_SCOPE = '/limrun-test-scope-default';
// Must match GLOBAL_SCOPE_KEY in packages/cli/src/lib/scope.ts.
const GLOBAL_SCOPE_KEY = '__global__';

async function withConfigModule<T>(
  fn: (config: typeof import('../packages/cli/src/lib/config'), ctx: ConfigTestContext) => T,
): Promise<T> {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'limrun-cli-config-test-'));
  const homedir = () => homeDir;
  const previousScope = process.env['LIM_INSTANCE_SCOPE'];
  process.env['LIM_INSTANCE_SCOPE'] = DEFAULT_TEST_SCOPE;
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
        process.env['LIM_INSTANCE_SCOPE'] = key;
      },
    };
    return fn(config, ctx);
  } finally {
    if (previousScope === undefined) {
      delete process.env['LIM_INSTANCE_SCOPE'];
    } else {
      process.env['LIM_INSTANCE_SCOPE'] = previousScope;
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

  test('migrates a legacy flat file onto the global scope, not worktrees', async () => {
    await withConfigModule((config, ctx) => {
      fs.mkdirSync(path.dirname(ctx.configFile), { recursive: true });
      fs.writeFileSync(
        ctx.configFile,
        JSON.stringify({
          ios: { id: 'ios_euna_01legacy', type: 'ios', apiUrl: 'https://ios.example.test' },
        }),
      );

      // A worktree must NOT inherit the legacy/global instance.
      ctx.setScope('/work/worktree-a');
      expect(config.loadLastIosInstance()).toBeNull();

      // The global (non-worktree) context reads the legacy instance out of the box.
      ctx.setScope(GLOBAL_SCOPE_KEY);
      expect(config.loadLastIosInstance()).toMatchObject({ id: 'ios_euna_01legacy' });

      // A write rewrites the file in the new shape with legacy data under the global key.
      config.registerCreatedInstance(iosInstanceWithId('ios_euna_01new'));
      const persisted = JSON.parse(fs.readFileSync(ctx.configFile, 'utf-8'));
      expect(persisted.version).toBe(2);
      expect(persisted.ios).toBeUndefined();
      expect(persisted.scopes[GLOBAL_SCOPE_KEY].ios).toMatchObject({ id: 'ios_euna_01new' });
    });
  });

  test('shares the global scope across non-worktree contexts but isolates worktrees', async () => {
    await withConfigModule((config, ctx) => {
      ctx.setScope(GLOBAL_SCOPE_KEY);
      config.registerCreatedInstance(iosInstanceWithId('ios_euna_01global'));

      // Any other non-worktree context resolves the same global instance.
      expect(config.loadLastIosInstance()).toMatchObject({ id: 'ios_euna_01global' });

      // A worktree does not see the global instance.
      ctx.setScope('/work/worktree-a');
      expect(config.loadLastIosInstance()).toBeNull();

      // The worktree gets its own, independent of global.
      config.registerCreatedInstance(iosInstanceWithId('ios_euna_01wt'));
      expect(config.loadLastIosInstance()).toMatchObject({ id: 'ios_euna_01wt' });

      ctx.setScope(GLOBAL_SCOPE_KEY);
      expect(config.loadLastIosInstance()).toMatchObject({ id: 'ios_euna_01global' });
    });
  });
});
