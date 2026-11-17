import { deriveTargetHttpPortUrlPrefix } from '@limrun/api/target-http-port';

jest.mock('ws', () => {
  const { EventEmitter } = require('events');

  class MockWebSocket extends EventEmitter {
    static OPEN = 1;
    readyState = MockWebSocket.OPEN;

    constructor() {
      super();
      process.nextTick(() => this['emit']('open'));
    }

    send(data: string, callback?: (err?: Error) => void): void {
      const message = JSON.parse(data);
      if (message.type === 'deviceInfo') {
        const reply = {
          type: 'deviceInfoResult',
          id: message.id,
          udid: 'test',
          screenWidth: 390,
          screenHeight: 844,
          model: 'iphone',
        };
        process.nextTick(() => this['emit']('message', Buffer.from(JSON.stringify(reply))));
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

describe('deriveTargetHttpPortUrlPrefix', () => {
  it('replaces the trailing /api with /targetHttpPort', () => {
    expect(deriveTargetHttpPortUrlPrefix('https://region.limrun.net/v1/ios_x/api')).toBe(
      'https://region.limrun.net/v1/ios_x/targetHttpPort',
    );
  });

  it('accepts a trailing slash after /api', () => {
    expect(deriveTargetHttpPortUrlPrefix('https://region.limrun.net/v1/ios_x/api/')).toBe(
      'https://region.limrun.net/v1/ios_x/targetHttpPort',
    );
  });

  it('returns undefined when the URL does not end in /api', () => {
    expect(deriveTargetHttpPortUrlPrefix('https://region.limrun.net/v1/ios_x')).toBeUndefined();
  });

  it('does not replace /api in the middle of the path', () => {
    expect(deriveTargetHttpPortUrlPrefix('https://region.limrun.net/api/v1/ios_x/control')).toBeUndefined();
  });
});

describe('iOS client targetHttpPortUrl', () => {
  async function connect(apiUrl: string) {
    const { createInstanceClient } = await import('../src/ios-client');
    return createInstanceClient({ apiUrl, token: 'test', logLevel: 'none' });
  }

  it('returns the URL of an instance port, derived from apiUrl', async () => {
    const client = await connect('https://region.limrun.net/v1/ios_x/api');
    try {
      expect(client.targetHttpPortUrl(22087)).toBe('https://region.limrun.net/v1/ios_x/targetHttpPort22087');
    } finally {
      client.disconnect();
    }
  });

  it('throws when apiUrl does not end in /api', async () => {
    const client = await connect('https://example.test');
    try {
      expect(() => client.targetHttpPortUrl(22087)).toThrow(
        'Cannot derive the target HTTP port URL: apiUrl does not end in /api',
      );
    } finally {
      client.disconnect();
    }
  });
});
