import type { LaunchAppOptions } from '../src/ios-client';

const sentMessages: Record<string, unknown>[] = [];
const mockSockets: Array<{ emit: (event: string, ...args: unknown[]) => boolean }> = [];

jest.mock('ws', () => {
  const { EventEmitter } = require('events');
  type EmittingSocket = { emit: (event: string, ...args: unknown[]) => boolean };

  class MockWebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;

    readyState = MockWebSocket.OPEN;

    constructor() {
      super();
      mockSockets.push(this as unknown as EmittingSocket);
      process.nextTick(() => this['emit']('open'));
    }

    send(data: string, callback?: (err?: Error) => void): void {
      const message = JSON.parse(data);
      sentMessages.push(message);

      if (message.type === 'deviceInfo') {
        process.nextTick(() => {
          this['emit'](
            'message',
            Buffer.from(
              JSON.stringify({
                type: 'deviceInfoResult',
                id: message.id,
                udid: 'test-udid',
                screenWidth: 390,
                screenHeight: 844,
                model: 'iphone',
              }),
            ),
          );
        });
      } else if (message.type === 'launchApp') {
        process.nextTick(() => {
          this['emit']('message', Buffer.from(JSON.stringify({ type: 'launchAppResult', id: message.id })));
        });
      } else if (message.type === 'watchApp' || message.type === 'unwatchApp') {
        process.nextTick(() => {
          this['emit'](
            'message',
            Buffer.from(JSON.stringify({ type: `${message.type}Result`, id: message.id })),
          );
        });
      } else if (message.type === 'appLogTail') {
        process.nextTick(() => {
          this['emit'](
            'message',
            Buffer.from(
              JSON.stringify({
                type: 'appLogTailResult',
                id: message.id,
                bundleId: message.bundleId,
                logs: 'first log line\nsecond log line',
              }),
            ),
          );
        });
      }

      callback?.();
    }

    ping(): void {}

    close(): void {
      this.readyState = 3;
      this['emit']('close');
    }
  }

  return { WebSocket: MockWebSocket };
});

describe('iOS launchApp serialization', () => {
  beforeEach(() => {
    sentMessages.length = 0;
    mockSockets.length = 0;
  });

  it('serializes legacy mode-only launches without runtime or launch inputs', async () => {
    const { createInstanceClient } = await import('../src/ios-client');
    const client = await createInstanceClient({
      apiUrl: 'https://example.test/v1/ios_123/api',
      token: 'token',
      logLevel: 'none',
    });

    await client.launchApp('com.example.app', 'RelaunchIfRunning');

    const launch = sentMessages.find((message) => message['type'] === 'launchApp');
    expect(launch).toMatchObject({
      type: 'launchApp',
      bundleId: 'com.example.app',
      mode: 'RelaunchIfRunning',
    });
    expect(launch).not.toHaveProperty('env');
    expect(launch).not.toHaveProperty('args');
    expect(launch).not.toHaveProperty('runtime');

    client.disconnect();
  });

  it('serializes typed Detox runtime launches without generic env or args', async () => {
    const { createInstanceClient } = await import('../src/ios-client');
    const client = await createInstanceClient({
      apiUrl: 'https://example.test/v1/ios_123/api',
      token: 'token',
      logLevel: 'none',
    });

    await client.launchApp('host.exp.Exponent', {
      mode: 'RelaunchIfRunning',
      runtime: {
        kind: 'detox',
        serverUrl: 'ws://10.0.0.1:57091',
        sessionId: 'limrun-detox',
        version: '20.51.1',
      },
    });

    const launch = sentMessages.find((message) => message['type'] === 'launchApp');
    expect(launch).toMatchObject({
      type: 'launchApp',
      bundleId: 'host.exp.Exponent',
      mode: 'RelaunchIfRunning',
      runtime: {
        kind: 'detox',
        serverUrl: 'ws://10.0.0.1:57091',
        sessionId: 'limrun-detox',
        version: '20.51.1',
      },
    });
    expect(launch).not.toHaveProperty('env');
    expect(launch).not.toHaveProperty('args');

    client.disconnect();
  });

  it('defaults Detox runtime launches to relaunch so injection is applied', async () => {
    const { createInstanceClient } = await import('../src/ios-client');
    const client = await createInstanceClient({
      apiUrl: 'https://example.test/v1/ios_123/api',
      token: 'token',
      logLevel: 'none',
    });

    await client.launchApp('host.exp.Exponent', {
      runtime: {
        kind: 'detox',
        serverUrl: 'ws://10.0.0.1:57091',
        sessionId: 'limrun-detox',
      },
    });

    const launch = sentMessages.find((message) => message['type'] === 'launchApp');
    expect(launch).toMatchObject({
      type: 'launchApp',
      bundleId: 'host.exp.Exponent',
      mode: 'RelaunchIfRunning',
      runtime: {
        kind: 'detox',
        serverUrl: 'ws://10.0.0.1:57091',
        sessionId: 'limrun-detox',
      },
    });

    client.disconnect();
  });

  it('rejects foreground Detox runtime launches before sending a request', async () => {
    const { createInstanceClient } = await import('../src/ios-client');
    const client = await createInstanceClient({
      apiUrl: 'https://example.test/v1/ios_123/api',
      token: 'token',
      logLevel: 'none',
    });

    sentMessages.length = 0;
    await expect(
      client.launchApp('host.exp.Exponent', {
        mode: 'ForegroundIfRunning',
        runtime: {
          kind: 'detox',
          serverUrl: 'ws://10.0.0.1:57091',
          sessionId: 'limrun-detox',
        },
      } as unknown as LaunchAppOptions),
    ).rejects.toThrow('runtime launches require RelaunchIfRunning');
    expect(sentMessages).toEqual([]);

    client.disconnect();
  });

  it('sends execId for onExit and invokes callback with fetched log lines', async () => {
    const { createInstanceClient } = await import('../src/ios-client');
    let resolveExit!: () => void;
    const exit = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const onExit = jest.fn(async (logs: string[], info: { reason: string }) => {
      expect(logs).toEqual(['first log line', 'second log line']);
      // A server without exit reasons only reports that the app ended.
      expect(info.reason).toBe('exit');
      resolveExit();
    });
    const client = await createInstanceClient({
      apiUrl: 'https://example.test/v1/ios_123/api',
      token: 'token',
      logLevel: 'none',
    });

    await client.launchApp('com.example.app', {
      mode: 'RelaunchIfRunning',
      onExit,
    });

    const launch = sentMessages.find((message) => message['type'] === 'launchApp');
    expect(launch).toMatchObject({
      type: 'launchApp',
      bundleId: 'com.example.app',
      mode: 'RelaunchIfRunning',
    });
    expect(launch?.['execId']).toEqual(expect.any(String));
    expect(launch).not.toHaveProperty('onExit');
    const execId = launch?.['execId'];
    if (typeof execId !== 'string') {
      throw new Error('launchApp did not send execId');
    }
    const socket = mockSockets[0];
    if (!socket) {
      throw new Error('mock WebSocket was not created');
    }

    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'appExit',
          execId,
          bundleId: 'com.example.app',
          logLineCount: 2,
        }),
      ),
    );

    await exit;
    const appLogTail = sentMessages.find((message) => message['type'] === 'appLogTail');
    expect(appLogTail).toMatchObject({
      type: 'appLogTail',
      bundleId: 'com.example.app',
      lines: 2,
    });

    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'appExit',
          execId,
          bundleId: 'com.example.app',
          logLineCount: 2,
        }),
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(onExit).toHaveBeenCalledTimes(1);

    client.disconnect();
  });

  it('delivers inline logs, the exit reason, and crash details without fetching logs', async () => {
    const { createInstanceClient } = await import('../src/ios-client');
    const client = await createInstanceClient({
      apiUrl: 'https://example.test/v1/ios_123/api',
      token: 'token',
      logLevel: 'none',
    });
    const exited = new Promise<[string[], unknown]>((resolve) => {
      void client.launchApp('com.example.app', { onExit: (logs, info) => resolve([logs, info]) });
    });
    await new Promise((resolve) => setImmediate(resolve));
    const execId = sentMessages.find((message) => message['type'] === 'launchApp')?.['execId'];
    const crash = {
      processName: 'App',
      pid: 42,
      shortMsg: 'EXC_BREAKPOINT (SIGTRAP)',
      longMsg: 'Fatal error: boom',
      stackTrace: 'Thread Crashed:',
      timeMillis: 1,
    };
    mockSockets[0]!.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'appExit',
          execId,
          bundleId: 'com.example.app',
          reason: 'crash',
          crash,
          logs: ['before crash'],
          logLineCount: 1,
        }),
      ),
    );

    await expect(exited).resolves.toEqual([
      ['before crash'],
      { bundleId: 'com.example.app', reason: 'crash', crash },
    ]);
    expect(sentMessages.some((message) => message['type'] === 'appLogTail')).toBe(false);

    client.disconnect();
  });

  it('watchApp reports the next exit once and stop() unwatches', async () => {
    const { createInstanceClient } = await import('../src/ios-client');
    const client = await createInstanceClient({
      apiUrl: 'https://example.test/v1/ios_123/api',
      token: 'token',
      logLevel: 'none',
    });
    const onExit = jest.fn();
    const watch = await client.watchApp('com.example.app', onExit);
    expect(sentMessages.find((message) => message['type'] === 'watchApp')).toEqual({
      type: 'watchApp',
      id: expect.any(String),
      bundleId: 'com.example.app',
      execId: watch.execId,
    });

    const exit = {
      type: 'appExit',
      execId: watch.execId,
      bundleId: 'com.example.app',
      reason: 'terminated',
      logs: [],
    };
    mockSockets[0]!.emit('message', Buffer.from(JSON.stringify(exit)));
    mockSockets[0]!.emit('message', Buffer.from(JSON.stringify(exit)));
    await new Promise((resolve) => setImmediate(resolve));
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith([], { bundleId: 'com.example.app', reason: 'terminated' });

    await watch.stop();
    expect(sentMessages.find((message) => message['type'] === 'unwatchApp')).toMatchObject({
      type: 'unwatchApp',
      execId: watch.execId,
    });

    client.disconnect();
  });
});
