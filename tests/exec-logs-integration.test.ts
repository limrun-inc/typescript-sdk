import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { observeExecLogs, ExecStreamClosedError, type ExecLogEvent } from '../src/exec-client';

describe('exec log transport', () => {
  let server: http.Server;
  let apiUrl: string;

  beforeEach(async () => {
    server = http.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('reconnects to the same concrete build and skips replayed output', async () => {
    const urls: string[] = [];
    server.on('request', (request, response) => {
      urls.push(request.url!);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (urls.length === 1) {
        response.end('id: 0\nevent: meta\ndata: {"id":"build-1"}\n\n');
      } else {
        response.write(
          'retry: 1\n\nid: 0\nevent: meta\ndata: {"id":"build-1"}\n\nid: 1\nevent: stdout\ndata: compiling\n\n',
        );
        if (urls.length > 2) response.write('id: 2\nevent: exitCode\ndata: 0\n\n');
        response.end();
      }
    });
    const events: ExecLogEvent[] = [];
    const result = await observeExecLogs('active', {
      apiUrl,
      token: 'test',
      follow: true,
      onEvent: (event) => events.push(event),
    });

    expect(result).toEqual({ execId: 'build-1', status: 'SUCCEEDED', exitCode: 0 });
    expect(urls).toEqual([
      '/exec/active/events?follow=false',
      '/exec/build-1/events?follow=true',
      '/exec/build-1/events?follow=true',
    ]);
    expect(events.filter((event) => event.type === 'stdout')).toEqual([
      { id: '1', type: 'stdout', data: 'compiling' },
    ]);
  });

  test('a transient HTTP failure reconnects rather than ending follow mode', async () => {
    let attempts = 0;
    server.on('request', (_request, response) => {
      if (++attempts === 1) {
        response.writeHead(503);
        response.end('temporarily unavailable');
      } else {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end('event: exitCode\ndata: 0\n\n');
      }
    });
    await expect(observeExecLogs('build-2', { apiUrl, token: 'test', follow: true })).resolves.toMatchObject({
      exitCode: 0,
    });
    expect(attempts).toBe(2);
  });

  test('a missing build rejects promptly so the CLI can try persisted logs', async () => {
    server.on('request', (_request, response) => {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ message: 'build not found' }));
    });
    await expect(observeExecLogs('build-404', { apiUrl, token: 'test', follow: true })).rejects.toMatchObject(
      { status: 404 },
    );
  });

  test('a permanent stream closure does not leave a pending observer', async () => {
    server.on('request', (_request, response) => response.writeHead(204).end());
    await expect(observeExecLogs('build-3', { apiUrl, token: 'test', follow: true })).rejects.toBeInstanceOf(
      ExecStreamClosedError,
    );
  });

  test('aborting observation closes the stream without cancelling the remote build', async () => {
    const methods: string[] = [];
    const controller = new AbortController();
    const closed = new Promise<void>((resolve) => {
      server.on('request', (request, response) => {
        methods.push(request.method!);
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('event: stdout\ndata: compiling\n\n');
        response.on('close', resolve);
      });
    });
    await expect(
      observeExecLogs('build-4', {
        apiUrl,
        token: 'test',
        follow: true,
        signal: controller.signal,
        onEvent: () => controller.abort(),
      }),
    ).rejects.toThrow('was aborted');
    await closed;
    expect(methods).toEqual(['GET']);
  });
});
