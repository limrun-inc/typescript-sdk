jest.mock('node:child_process', () => ({
  execFile: jest.fn(
    (_file: string, _args: readonly string[], callback: (error: Error | null) => void): void => {
      process.nextTick(() => callback(null));
    },
  ),
}));

jest.mock('../src/tunnel', () => ({
  isNonRetryableError: jest.fn(() => false),
  startTcpTunnel: jest.fn(async () => ({
    address: {
      address: '127.0.0.1',
      port: 5038,
    },
    close: jest.fn(),
  })),
}));

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

    send(_data: string, callback?: (error?: Error) => void): void {
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

import { execFile } from 'node:child_process';

describe('Android ADB tunnel', () => {
  test('passes the adb command and arguments separately', async () => {
    const { createInstanceClient } = await import('../src/instance-client');
    const client = await createInstanceClient({
      apiUrl: 'https://example.test/v1/android_123/api',
      adbUrl: 'wss://example.test/v1/android_123/adb',
      token: 'token',
      adbPath: '/Applications/Android SDK/platform-tools/adb',
      logLevel: 'none',
    });

    await client.startAdbTunnel();

    expect(jest.mocked(execFile)).toHaveBeenCalledWith(
      '/Applications/Android SDK/platform-tools/adb',
      ['connect', '127.0.0.1:5038'],
      expect.any(Function),
    );

    client.disconnect();
  });
});
