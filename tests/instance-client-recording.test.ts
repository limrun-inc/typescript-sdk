import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { createInstanceClient, type InstanceClient, RecordingQuality } from '../src/instance-client';

describe('Android recording sessions', () => {
  let server: Server;
  let signaling: WebSocketServer;
  let client: InstanceClient;
  let apiUrl: string;
  let requests: Array<Record<string, any>>;
  let downloads: Array<{ path: string; authorization: string | undefined }>;
  let commandError: string | undefined;
  let returnedId: string | undefined;
  const video = Buffer.from('a completed recording');

  beforeEach(async () => {
    requests = [];
    downloads = [];
    commandError = undefined;
    returnedId = undefined;
    server = createServer((req, res) => {
      downloads.push({ path: req.url!, authorization: req.headers.authorization });
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': video.length });
      res.end(video);
    });
    signaling = new WebSocketServer({ server, path: '/android/api/ws' });
    signaling.on('connection', (socket) => {
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (!message.type.includes('Recording')) return;
        requests.push(message);
        socket.send(
          JSON.stringify({
            type: `${message.type}Result`,
            id: message.id,
            ...(commandError ?
              { error: { code: 'recording_failed', message: commandError } }
            : {
                payload:
                  message.type === 'startRecordingSession' ?
                    { recordingId: returnedId ?? message.recordingId ?? randomUUID() }
                  : message.type === 'stopRecordingSession' && returnedId ? { recordingId: returnedId }
                  : {},
              }),
          }),
        );
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/android/api`;
    client = await createInstanceClient({ apiUrl, token: 'instance-token', logLevel: 'none' });
  });

  afterEach(async () => {
    client.disconnect();
    for (const socket of signaling.clients) socket.terminate();
    await new Promise<void>((resolve) => signaling.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('stops and downloads a snippet independently, with a unique URL and auth header', async () => {
    const full = await client.startRecordingSession({ quality: RecordingQuality.Q7, persist: true });
    const snippet = await client.startRecordingSession({ quality: RecordingQuality.Q7 });
    expect(full).not.toBe(snippet);
    const directory = await mkdtemp(join(tmpdir(), 'limrun-recording-test-'));
    try {
      const localPath = join(directory, 'snippet.mp4');
      const snippetUrl = await client.stopRecordingSession(snippet, { localPath });
      expect(await readFile(localPath)).toEqual(video);
      expect(downloads).toEqual([
        {
          path: `/android/api/files?path=${encodeURIComponent(
            `/data/local/tmp/recordings/recording_${snippet}.mp4`,
          )}`,
          authorization: 'Bearer instance-token',
        },
      ]);
      expect(requests.map((r) => r['type'])).toEqual([
        'startRecordingSession',
        'startRecordingSession',
        'stopRecordingSession',
      ]);
      expect(requests[0]).toMatchObject({ quality: 7, persist: true });
      expect(requests[2]).toMatchObject({ recordingId: snippet });
      const fullUrl = await client.stopRecordingSession(full, {
        presignedUrl: 'https://storage.example.test/full.mp4',
      });
      expect(fullUrl).not.toBe(snippetUrl);
      expect(requests[3]).toMatchObject({
        recordingId: full,
        upload: { presignedUrl: 'https://storage.example.test/full.mp4' },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('accepts a caller ID and downloads the server-selected recording when stop omits the ID', async () => {
    expect(await client.startRecordingSession({ recordingId: 'run-1' })).toBe('run-1');
    expect(requests[0]).toMatchObject({ recordingId: 'run-1' });
    returnedId = 'run-2';
    const directory = await mkdtemp(join(tmpdir(), 'limrun-recording-test-'));
    try {
      const localPath = join(directory, 'latest.mp4');
      expect(await client.stopRecordingSession(undefined, { localPath })).toBe(
        `${apiUrl}/files?path=${encodeURIComponent('/data/local/tmp/recordings/recording_run-2.mp4')}`,
      );
      expect(requests[1]).not.toHaveProperty('recordingId');
      expect(await readFile(localPath)).toEqual(video);
      expect(downloads[0]?.authorization).toBe('Bearer instance-token');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each(['', '../other', 'bad id', 'bad\n', 'bad/id', 'Run-1', 'x'.repeat(65)])(
    'rejects unsafe custom ID %p',
    async (recordingId) => {
      await expect(client.startRecordingSession({ recordingId })).rejects.toThrow('recordingId');
      await expect(client.stopRecordingSession(recordingId)).rejects.toThrow('recordingId');
      expect(requests).toHaveLength(0);
    },
  );

  test('rejects a missing ID in an implicit-stop response instead of downloading the legacy file', async () => {
    await expect(client.stopRecordingSession()).rejects.toThrow('stopped recordingId');
    expect(downloads).toHaveLength(0);
  });

  test('implicit stop can finish a recording started by an older client', async () => {
    returnedId = 'legacy:recording';
    expect(await client.stopRecordingSession()).toBe(
      `${apiUrl}/files?path=${encodeURIComponent('/data/local/tmp/recordings/video_recording.mp4')}`,
    );
    expect(requests[0]).not.toHaveProperty('recordingId');
  });

  test('keeps the legacy commands and download URL unchanged', async () => {
    await client.startRecording();
    expect(await client.stopRecording({})).toBe(
      `${apiUrl}/files?path=${encodeURIComponent('/data/local/tmp/recordings/video_recording.mp4')}`,
    );
    expect(requests.map((r) => r['type'])).toEqual(['startRecording', 'stopRecording']);
    expect(requests.every((r) => r['recordingId'] === undefined)).toBe(true);
  });

  test('rejects invalid quality and IDs before sending a command', async () => {
    await expect(client.startRecordingSession({ quality: 11 as RecordingQuality })).rejects.toThrow(
      'quality',
    );
    await expect(client.stopRecordingSession('../video_recording')).rejects.toThrow('recordingId');
    expect(requests).toHaveLength(0);
  });

  test('propagates server errors without falling back to the legacy recording', async () => {
    commandError = 'Concurrent recordings must use the same quality: 5';
    await expect(client.startRecordingSession({ quality: RecordingQuality.Q10 })).rejects.toThrow(
      commandError,
    );
    expect(requests.map((r) => r['type'])).toEqual(['startRecordingSession']);
  });

  test('rejects an invalid server recording ID', async () => {
    returnedId = '../../another-file';
    await expect(client.startRecordingSession()).rejects.toThrow('recordingId');
  });
});
