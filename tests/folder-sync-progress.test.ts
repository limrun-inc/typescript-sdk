import fs from 'fs';
import os from 'os';
import path from 'path';
import { syncFolder, type SyncProgressEvent } from '@limrun/api/folder-sync';
import { nodeProxyTransport } from '@limrun/api/internal/proxy-transport';

const originalFetch = nodeProxyTransport.fetch;

describe('sync progress events', () => {
  afterEach(() => {
    nodeProxyTransport.fetch = originalFetch;
  });

  test('emits scan, diff, and upload with monotonic counters; a throwing callback is swallowed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'limsync-progress-'));
    fs.writeFileSync(path.join(root, 'a.swift'), 'let a = 1\n'.repeat(1000));
    fs.writeFileSync(path.join(root, 'b.swift'), 'let b = 2\n'.repeat(1000));
    nodeProxyTransport.fetch = jest.fn(async (_input: unknown, init?: RequestInit) => {
      for await (const _chunk of init!.body as AsyncIterable<Buffer>) {
        // drain the stream so upload progress fires
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof nodeProxyTransport.fetch;

    const events: SyncProgressEvent[] = [];
    await syncFolder(root, {
      apiUrl: 'https://xcode.example.test',
      token: 't',
      udid: 'test',
      basisCacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'limsync-progress-basis-')),
      install: false,
      launchMode: 'ForegroundIfRunning',
      watch: false,
      maxPatchBytes: 4 * 1024 * 1024,
      log: () => {},
      ignoreFn: () => false,
      onProgress: (e) => {
        events.push(e);
        throw new Error('callback errors must not fail the sync');
      },
    });

    const phases = new Set(events.map((e) => e.phase));
    expect(phases).toEqual(new Set(['scan', 'diff', 'upload']));

    const scans = events.filter((e) => e.phase === 'scan');
    expect(scans[scans.length - 1]).toEqual({ phase: 'scan', files: 2, hashed: 2 });
    const diffs = events.filter((e) => e.phase === 'diff');
    expect(diffs[diffs.length - 1]).toEqual({ phase: 'diff', checked: 2, total: 2, changed: 2 });
    const uploads = events.filter((e) => e.phase === 'upload');
    const last = uploads[uploads.length - 1]!;
    expect(last.sentBytes).toBe(last.totalBytes);
    expect(last.totalBytes).toBeGreaterThan(0);
    for (let i = 1; i < uploads.length; i++) {
      expect(uploads[i]!.sentBytes).toBeGreaterThanOrEqual(uploads[i - 1]!.sentBytes);
    }
  });
});
