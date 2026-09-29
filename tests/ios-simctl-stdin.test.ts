export {};

const sentMessages: Record<string, unknown>[] = [];
// The fake simulator pasteboard: pbcopy stores its stdin, pbpaste returns it.
let pasteboard = Buffer.alloc(0);

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

    reply(message: Record<string, unknown>): void {
      process.nextTick(() => this['emit']('message', Buffer.from(JSON.stringify(message))));
    }

    send(data: string, callback?: (err?: Error) => void): void {
      const message = JSON.parse(data);
      sentMessages.push(message);

      if (message.type === 'deviceInfo') {
        this.reply({ type: 'deviceInfoResult', id: message.id, udid: 'test-udid', model: 'iphone' });
      } else if (message.type === 'simctl') {
        const [command] = message.args;
        if (command === 'pbcopy') {
          pasteboard = Buffer.from(message.stdin ?? '', 'base64');
          this.reply({ type: 'simctlStream', id: message.id, exitCode: 0 });
        } else if (command === 'pbpaste') {
          this.reply({ type: 'simctlStream', id: message.id, stdout: pasteboard.toString('base64') });
          this.reply({ type: 'simctlStream', id: message.id, exitCode: 0 });
        }
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

describe('iOS simctl stdin', () => {
  beforeEach(() => {
    sentMessages.length = 0;
    pasteboard = Buffer.alloc(0);
  });

  it('sends stdin as base64 only when given, so pbcopy and pbpaste round-trip', async () => {
    const { createInstanceClient } = await import('../src/ios-client');
    const client = await createInstanceClient({
      apiUrl: 'https://example.test/v1/ios_123/api',
      token: 'token',
      logLevel: 'none',
    });

    await client.simctl(['pbcopy', 'booted'], { stdin: 'hello ÆØÅ 日本' }).wait();
    const pasted = await client.simctl(['pbpaste', 'booted']).wait();
    expect(pasted.stdout).toBe('hello ÆØÅ 日本');

    const simctl = sentMessages.filter((m) => m['type'] === 'simctl');
    expect(simctl[0]).toMatchObject({ stdin: Buffer.from('hello ÆØÅ 日本').toString('base64') });
    expect(simctl[1]).not.toHaveProperty('stdin');
    client.disconnect();
  });
});
