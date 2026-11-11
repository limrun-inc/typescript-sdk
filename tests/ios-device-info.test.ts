export {};

const mockRequests: Record<string, unknown>[] = [];

jest.mock('ws', () => {
  const { EventEmitter } = require('events');

  class MockWebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;

    readyState = MockWebSocket.OPEN;
    deviceInfoReads = 0;

    constructor() {
      super();
      process.nextTick(() => this['emit']('open'));
    }

    send(data: string, callback?: (err?: Error) => void): void {
      const message = JSON.parse(data);
      mockRequests.push(message);
      if (message.type === 'deviceInfo') {
        const reply = {
          type: 'deviceInfoResult',
          id: message.id,
          udid: 'test-udid',
          model: 'iPhone 16 Pro',
          osVersion: '27.0',
          screenWidth: 402,
          screenHeight: 874,
          ...(this.deviceInfoReads++ > 0 ?
            { orientation: 'landscapeRight', displayWidth: 874, displayHeight: 402 }
          : {}),
        };
        process.nextTick(() => this['emit']('message', Buffer.from(JSON.stringify(reply))));
      }
      if (message.type === 'elementTree') {
        process.nextTick(() =>
          this['emit'](
            'message',
            Buffer.from(
              JSON.stringify({
                type: 'elementTreeResult',
                id: message.id,
                json: JSON.stringify([
                  { AXLabel: 'Scroll view', has_offscreen_children: true, children: [] },
                ]),
              }),
            ),
          ),
        );
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

describe('iOS device info', () => {
  it('carries the iOS version the simulator runs', async () => {
    const { createInstanceClient } = await import('../src/ios-client');
    const client = await createInstanceClient({
      apiUrl: 'https://example.test',
      token: 'test',
      logLevel: 'none',
    });
    try {
      expect(client.deviceInfo.osVersion).toBe('27.0');
      expect(client.deviceInfo.orientation).toBeUndefined();
      const fresh = await client.getDeviceInfo();
      expect(fresh).toMatchObject({ orientation: 'landscapeRight', displayWidth: 874, displayHeight: 402 });
      expect(client.deviceInfo).toBe(fresh);
      expect(fresh.screenWidth).toBe(402);
      expect(mockRequests.filter((r) => r['type'] === 'elementTree')).toHaveLength(0);
      await client.elementTree();
      expect(mockRequests.at(-1)).not.toHaveProperty('visibleOnly');
      const tree = await client.elementTree(undefined, { visibleOnly: true });
      expect(mockRequests.at(-1)).toMatchObject({ type: 'elementTree', visibleOnly: true });
      expect(tree[0]?.has_offscreen_children).toBe(true);
      await client.elementTreeRaw(undefined, { visibleOnly: true });
      expect(mockRequests.at(-1)).toMatchObject({ type: 'elementTree', visibleOnly: true });
      await client.elementTree({ x: 10, y: 20 });
      expect(mockRequests.at(-1)).toMatchObject({ point: { x: 10, y: 20 } });
    } finally {
      client.disconnect();
    }
  });
});
