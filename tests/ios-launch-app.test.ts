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

  it('sends execId for onShutdown and invokes callback with fetched log lines', async () => {
    const { createInstanceClient } = await import('../src/ios-client');
    let resolveShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    const onShutdown = jest.fn(async (exitCode: number, logs: string[]) => {
      expect(exitCode).toBe(42);
      expect(logs).toEqual(['first log line', 'second log line']);
      resolveShutdown();
    });
    const client = await createInstanceClient({
      apiUrl: 'https://example.test/v1/ios_123/api',
      token: 'token',
      logLevel: 'none',
    });

    await client.launchApp('com.example.app', {
      mode: 'RelaunchIfRunning',
      onShutdown,
    });

    const launch = sentMessages.find((message) => message['type'] === 'launchApp');
    expect(launch).toMatchObject({
      type: 'launchApp',
      bundleId: 'com.example.app',
      mode: 'RelaunchIfRunning',
    });
    expect(launch?.['execId']).toEqual(expect.any(String));
    expect(launch).not.toHaveProperty('onShutdown');
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
          type: 'appShutdown',
          execId,
          bundleId: 'com.example.app',
          exitCode: 42,
          logLineCount: 2,
        }),
      ),
    );

    await shutdown;
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
          type: 'appShutdown',
          execId,
          bundleId: 'com.example.app',
          exitCode: 42,
          logLineCount: 2,
        }),
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(onShutdown).toHaveBeenCalledTimes(1);

    client.disconnect();
  });
});
