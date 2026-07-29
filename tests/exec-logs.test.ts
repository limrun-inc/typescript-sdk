jest.mock('eventsource-client', () => ({
  createEventSource: jest.fn(),
}));

import { createEventSource, type EventSourceOptions } from 'eventsource-client';
import { observeExecLogs, type ExecLogEvent } from '../src/exec-client';
import { nodeProxyTransport } from '../src/internal/proxy-transport';
import type { RequestInfo } from '../src/internal/builtin-types';

const originalFetch = nodeProxyTransport.fetch;

describe('existing exec logs', () => {
  afterEach(() => {
    nodeProxyTransport.fetch = originalFetch;
    jest.mocked(createEventSource).mockReset();
  });

  test('fetches a finite snapshot and reports a running build', async () => {
    const calls: string[] = [];
    nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo) => {
      calls.push(String(input));
      return new Response(
        'id: 1\nevent: meta\ndata: {"id":"build-1","status":"RUNNING"}\n\n' +
          'id: 2\nevent: command\ndata: xcodebuild\n\n' +
          'id: 3\nevent: stdout\ndata: compiling\n\n',
      );
    });
    const events: ExecLogEvent[] = [];

    await expect(
      observeExecLogs('active', {
        apiUrl: 'https://xcode.example.test',
        token: 'token',
        onEvent: (event) => events.push(event),
      }),
    ).resolves.toEqual({ execId: 'build-1', status: 'RUNNING' });

    expect(calls).toEqual(['https://xcode.example.test/exec/active/events?follow=false']);
    expect(events).toEqual([
      { id: '1', type: 'meta', data: '{"id":"build-1","status":"RUNNING"}' },
      { id: '2', type: 'command', data: 'xcodebuild' },
      { id: '3', type: 'stdout', data: 'compiling' },
    ]);
  });

  test('recognizes a terminal snapshot', async () => {
    nodeProxyTransport.fetch = jest.fn(async () => {
      return new Response('event: stderr\ndata: failed\n\nevent: exitCode\ndata: 7\n\n');
    });

    await expect(
      observeExecLogs('build-2', {
        apiUrl: 'https://gradle.example.test',
        token: 'token',
      }),
    ).resolves.toEqual({ execId: 'build-2', status: 'FAILED', exitCode: 7 });
  });

  test('surfaces a missing retained build', async () => {
    nodeProxyTransport.fetch = jest.fn(async () => {
      return new Response('{"message":"build not found"}', {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await expect(
      observeExecLogs('build-missing', {
        apiUrl: 'https://xcode.example.test',
        token: 'token',
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  test('replays and follows until the terminal event', async () => {
    nodeProxyTransport.fetch = jest.fn(async () => new Response(null, { status: 200 }));
    jest.mocked(createEventSource).mockImplementationOnce((optionsOrUrl) => {
      const options = optionsOrUrl as EventSourceOptions;
      setTimeout(() => {
        options.onMessage?.({ event: 'stdout', data: 'building' });
        options.onMessage?.({ event: 'exitCode', data: '0' });
      }, 0);
      return { close: jest.fn() } as never;
    });
    const events: ExecLogEvent[] = [];

    await expect(
      observeExecLogs('build-3', {
        apiUrl: 'https://xcode.example.test',
        token: 'token',
        follow: true,
        onEvent: (event) => events.push(event),
      }),
    ).resolves.toEqual({ execId: 'build-3', status: 'SUCCEEDED', exitCode: 0 });
    expect(events).toEqual([
      { type: 'stdout', data: 'building' },
      { type: 'exitCode', data: '0' },
    ]);
  });

  test('rejects when a follow-mode event callback fails', async () => {
    jest.mocked(createEventSource).mockImplementationOnce((optionsOrUrl) => {
      const options = optionsOrUrl as EventSourceOptions;
      setTimeout(() => {
        options.onMessage?.({ event: 'stdout', data: 'building' });
        options.onMessage?.({ event: 'stdout', data: 'must be ignored' });
      }, 0);
      return { close: jest.fn() } as never;
    });
    const callbackError = new Error('output failed');
    const onEvent = jest.fn(() => {
      throw callbackError;
    });

    await expect(
      observeExecLogs('build-4', {
        apiUrl: 'https://xcode.example.test',
        token: 'token',
        follow: true,
        onEvent,
      }),
    ).rejects.toBe(callbackError);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});
