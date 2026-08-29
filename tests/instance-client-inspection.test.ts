jest.mock('../src/destination-tunnel-dialer', () => ({
  startDestinationTcpTunnel: jest.fn(async (_url: string, _token: string, options: unknown) => ({
    tunnelId: 'tunnel-1',
    selectors: [],
    inspection: (options as { inspection: unknown }).inspection,
    close: jest.fn(),
    getConnectionState: () => 'connected',
    onConnectionStateChange: () => () => {},
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

import { startDestinationTcpTunnel } from '../src/destination-tunnel-dialer';
import { createInstanceClient } from '../src/instance-client';

describe('Android instance tunnel inspection', () => {
  test('defaults inspection on and forwards body capture callbacks', async () => {
    const client = await createInstanceClient({
      apiUrl: 'https://example.test/android',
      adbUrl: 'wss://example.test/android/adb',
      token: 'instance-token',
      logLevel: 'none',
    });
    const onInspectionEvent = jest.fn();
    const onInspectionError = jest.fn();
    try {
      await client.startTunnel({
        selectors: ['api.example.test'],
        onInspectionEvent,
        onInspectionError,
      });
      expect(jest.mocked(startDestinationTcpTunnel)).toHaveBeenLastCalledWith(
        'wss://example.test/android/adb/tunnel',
        'instance-token',
        expect.objectContaining({
          selectors: ['api.example.test'],
          inspection: { enabled: true, captureBodies: false },
          onInspectionEvent,
          onInspectionError,
        }),
      );

      await client.startTunnel({
        selectors: ['api.example.test'],
        inspection: { captureBodies: true, maxBodyBytes: 4096 },
      });
      expect(jest.mocked(startDestinationTcpTunnel)).toHaveBeenLastCalledWith(
        expect.any(String),
        'instance-token',
        expect.objectContaining({
          inspection: { enabled: true, captureBodies: true, maxBodyBytes: 4096 },
        }),
      );
    } finally {
      client.disconnect();
    }
  });
});
