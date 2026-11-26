import { Limrun } from '@limrun/api';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

// The instance keeps build state under the folder a project syncs into, so the folder name decides
// whether two checkouts of one project can share that state.

function decodeBody(raw: Buffer, encoding: string | undefined): Buffer {
  if (encoding === 'gzip') return zlib.gunzipSync(raw);
  if (encoding === 'zstd') return (zlib as any).zstdDecompressSync(raw);
  return raw;
}

async function startSyncServer(): Promise<{ url: string; rootNames: string[]; close: () => Promise<void> }> {
  const rootNames: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = decodeBody(Buffer.concat(chunks), req.headers['content-encoding'] as string);
      const meta = JSON.parse(body.subarray(4, 4 + body.readUInt32BE(0)).toString('utf-8'));
      rootNames.push(meta.rootName);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    rootNames,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe('Xcode sync folder name', () => {
  let temp: string;
  let checkout: string;

  const writeProject = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'App.swift'), 'import SwiftUI\n');
  };

  // Lays out what `git worktree add` leaves behind: a .git file pointing into the main checkout.
  const addWorktree = (name: string): string => {
    const worktree = path.join(temp, name);
    const gitDir = path.join(checkout, '.git', 'worktrees', name);
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
    fs.writeFileSync(path.join(gitDir, 'HEAD'), `ref: refs/heads/${name}\n`);
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`);
    return worktree;
  };

  const syncedFolderNames = async (projects: string[], opts?: { rootName?: string }): Promise<string[]> => {
    const server = await startSyncServer();
    try {
      const xcode = await new Limrun({ apiKey: 'test-key' }).xcodeInstances.createClient({
        apiUrl: server.url,
        token: 'test-token',
        logLevel: 'none',
      });
      for (const [i, project] of projects.entries()) {
        await xcode.sync(project, {
          watch: false,
          install: false,
          basisCacheDir: path.join(temp, `basis-${i}`),
          ...opts,
        });
      }
    } finally {
      await server.close();
    }
    return server.rootNames;
  };

  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-sync-folder-'));
    checkout = path.join(temp, 'garden-planner-main');
    fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
    fs.writeFileSync(path.join(checkout, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(
      path.join(checkout, '.git', 'config'),
      '[remote "origin"]\n\turl = git@github.com:acme/garden-planner.git\n',
    );
  });

  afterEach(() => {
    fs.rmSync(temp, { recursive: true, force: true });
  });

  test('a project at the repository root syncs into the same folder from every worktree', async () => {
    writeProject(checkout);
    const worktrees = [addWorktree('fix-login-7f3a'), addWorktree('new-onboarding')];
    worktrees.forEach(writeProject);

    expect(await syncedFolderNames([checkout, ...worktrees])).toEqual([
      'garden-planner',
      'garden-planner',
      'garden-planner',
    ]);
  });

  test('a project in a subdirectory keeps its directory name', async () => {
    const worktree = addWorktree('fix-login-7f3a');
    const projects = [path.join(checkout, 'apps', 'ios'), path.join(worktree, 'apps', 'ios')];
    projects.forEach(writeProject);

    expect(await syncedFolderNames(projects)).toEqual(['ios', 'ios']);
  });

  test('a project outside Git syncs into a folder named after the local one', async () => {
    const project = path.join(temp, 'scratch-app');
    writeProject(project);

    expect(await syncedFolderNames([project])).toEqual(['scratch-app']);
  });

  test('an explicit folder name wins', async () => {
    writeProject(checkout);

    expect(await syncedFolderNames([checkout], { rootName: 'pinned' })).toEqual(['pinned']);
  });
});
