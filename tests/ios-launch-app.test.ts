import type { LaunchAppOptions } from '../src/ios-client';

const sentMessages: Record<string, unknown>[] = [];

jest.mock('ws', () => {
  const { EventEmitter } = require('events');

  class MockWebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;

    readyState = MockWebSocket.OPEN;

    constructor() {
      super();
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
});
