import fs from 'fs';
import os from 'os';
import path from 'path';

import { GLOBAL_SCOPE_KEY } from '../packages/cli/src/lib/scope';

type ScopeModule = typeof import('../packages/cli/src/lib/scope');
type WorkspaceModule = typeof import('../packages/cli/src/lib/workspace');

interface ScopeTestContext {
  scope: ScopeModule;
  workspace: WorkspaceModule;
  homeDir: string;
}

/**
 * Load fresh copies of scope.ts + workspace.ts with a temp home directory and
 * `git rev-parse --show-toplevel` stubbed to either return a path or throw
 * (simulating "not in a git repo"). LIM_WORKSPACE is cleared so the
 * assignment/git/global fallback is what gets exercised.
 */
async function withScopeModule<T>(gitTop: string | null, fn: (ctx: ScopeTestContext) => T): Promise<T> {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'limrun-scope-test-'));
  const homedir = () => homeDir;
  const previousWorkspace = process.env['LIM_WORKSPACE'];
  delete process.env['LIM_WORKSPACE'];
  jest.resetModules();
  jest.doMock('os', () => {
    const actual = jest.requireActual<typeof import('os')>('os');
    return { ...actual, homedir, default: { ...actual, homedir } };
  });
  jest.doMock('child_process', () => ({
    execFileSync: jest.fn(() => {
      if (gitTop === null) {
        throw new Error('fatal: not a git repository');
      }
      return `${gitTop}\n`;
    }),
  }));

  try {
    const scope = await import('../packages/cli/src/lib/scope');
    const workspace = await import('../packages/cli/src/lib/workspace');
    return fn({ scope, workspace, homeDir });
  } finally {
    if (previousWorkspace === undefined) {
      delete process.env['LIM_WORKSPACE'];
    } else {
      process.env['LIM_WORKSPACE'] = previousWorkspace;
    }
    jest.dontMock('os');
    jest.dontMock('child_process');
    jest.resetModules();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

describe('CLI scope resolution', () => {
  test('shares the global slot when not inside a git repo', async () => {
    await withScopeModule(null, ({ scope }) => {
      expect(scope.getScopeKey()).toBe(GLOBAL_SCOPE_KEY);
      expect(scope.isGlobalScopeKey(scope.getScopeKey())).toBe(true);
    });
  });

  test('isolates by the git repo/worktree root when inside a repo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limrun-scope-repo-'));
    try {
      await withScopeModule(dir, ({ scope }) => {
        expect(scope.getScopeKey()).toBe(fs.realpathSync.native(dir));
        expect(scope.isGlobalScopeKey(scope.getScopeKey())).toBe(false);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('LIM_WORKSPACE overrides the assignment/git/global fallback', async () => {
    await withScopeModule(null, ({ scope }) => {
      process.env['LIM_WORKSPACE'] = 'my-shared-agent';
      try {
        expect(scope.getScopeKey()).toBe('my-shared-agent');
      } finally {
        delete process.env['LIM_WORKSPACE'];
      }
    });
  });

  test('setScopeOverride takes precedence over everything', async () => {
    await withScopeModule(null, ({ scope }) => {
      process.env['LIM_WORKSPACE'] = 'from-env';
      scope.setScopeOverride('from-flag');
      try {
        expect(scope.getScopeKey()).toBe('from-flag');
      } finally {
        scope.setScopeOverride(undefined);
        delete process.env['LIM_WORKSPACE'];
      }
    });
  });

  test('an assignment at or below the git root overrides git auto-detection', async () => {
    const cwd = process.cwd();
    const parent = path.dirname(cwd); // git root is shallower than the assignment
    await withScopeModule(parent, ({ scope, workspace }) => {
      workspace.assignWorkspaceDir(cwd, 'leaf-ws');
      expect(scope.getScopeKey()).toBe('leaf-ws');
    });
  });

  test('an unrelated git root does not shadow an assignment at cwd', async () => {
    await withScopeModule('/some/unrelated/git/repo', ({ scope, workspace }) => {
      workspace.assignWorkspaceDir(process.cwd(), 'assigned-ws');
      expect(scope.getScopeKey()).toBe('assigned-ws');
    });
  });

  test('a deeper git worktree keeps its own isolation under a broad parent assignment', async () => {
    const cwd = process.cwd();
    const grandparent = path.dirname(path.dirname(cwd)); // assignment is shallower than git root
    await withScopeModule(cwd, ({ scope, workspace }) => {
      workspace.assignWorkspaceDir(grandparent, 'broad-ws');
      expect(scope.getScopeKey()).toBe(fs.realpathSync.native(cwd));
    });
  });

  test('LIM_WORKSPACE still beats a directory assignment', async () => {
    await withScopeModule(null, ({ scope, workspace }) => {
      workspace.assignWorkspaceDir(process.cwd(), 'assigned-ws');
      process.env['LIM_WORKSPACE'] = 'env-ws';
      try {
        expect(scope.getScopeKey()).toBe('env-ws');
      } finally {
        delete process.env['LIM_WORKSPACE'];
      }
    });
  });
});

describe('workspace directory assignments', () => {
  test('subdirectories inherit an ancestor assignment, and unassign removes it', async () => {
    await withScopeModule(null, ({ workspace }) => {
      workspace.assignWorkspaceDir('/projects/service-a', 'service-a');

      expect(workspace.lookupWorkspaceForDir('/projects/service-a')).toBe('service-a');
      expect(workspace.lookupWorkspaceForDir('/projects/service-a/src/deep')).toBe('service-a');
      expect(workspace.lookupWorkspaceForDir('/projects/service-b')).toBeUndefined();

      expect(workspace.unassignWorkspaceDir('/projects/service-a')).toBe(true);
      expect(workspace.lookupWorkspaceForDir('/projects/service-a')).toBeUndefined();
      expect(workspace.unassignWorkspaceDir('/projects/service-a')).toBe(false);
    });
  });

  test('different directories can share one workspace by name', async () => {
    await withScopeModule(null, ({ workspace }) => {
      workspace.assignWorkspaceDir('/projects/a', 'shared-pool');
      workspace.assignWorkspaceDir('/projects/b', 'shared-pool');

      expect(workspace.lookupWorkspaceForDir('/projects/a')).toBe('shared-pool');
      expect(workspace.lookupWorkspaceForDir('/projects/b')).toBe('shared-pool');
    });
  });
});
