export {};

const sentMessages: Record<string, unknown>[] = [];

// The fake LLDB echoes each input chunk and exits 0 when its input closes, or 143 when terminated.
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
      } else if (message.type === 'lldb') {
        this.reply({
          type: 'simctlStream',
          id: message.id,
          stdout: Buffer.from('(lldb) ').toString('base64'),
        });
        if (!message.keepStdinOpen) {
          this.reply({ type: 'simctlStream', id: message.id, exitCode: 0 });
        }
      } else if (message.type === 'lldbInput') {
        if (message.data) {
          this.reply({ type: 'simctlStream', id: message.id, stdout: message.data });
        }
        if (message.close) {
          this.reply({ type: 'simctlStream', id: message.id, exitCode: 0 });
        }
      } else if (message.type === 'simctlTerminate') {
        this.reply({ type: 'simctlStream', id: message.id, exitCode: 143 });
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

async function connect() {
  const { createInstanceClient } = await import('../src/ios-client');
  return createInstanceClient({
    apiUrl: 'https://example.test/v1/ios_123/api',
    token: 'token',
    logLevel: 'none',
  });
}

describe('iOS lldb', () => {
  beforeEach(() => {
    sentMessages.length = 0;
  });

  it('runs a one-shot session against a bundle ID and sends only the fields it was given', async () => {
    const client = await connect();

    const result = await client.lldb(['--batch', '-o', 'bt'], { bundleId: 'com.example.app' }).wait();
    expect(result).toEqual({ code: 0, stdout: '(lldb) ', stderr: '' });

    const request = sentMessages.find((m) => m['type'] === 'lldb');
    expect(request).toMatchObject({ args: ['--batch', '-o', 'bt'], bundleId: 'com.example.app' });
    expect(request).not.toHaveProperty('pid');
    expect(request).not.toHaveProperty('stdin');
    expect(request).not.toHaveProperty('keepStdinOpen');
    client.disconnect();
  });

  it('feeds a live session through write and ends it by closing the input', async () => {
    const client = await connect();

    const session = client.lldb([], { pid: 4321, stdin: 'bt\n', keepStdinOpen: true });
    session.write('frame variable\n');
    session.end();
    // Input waits for the session's first frame: the instance drops what arrives before it.
    expect(sentMessages.some((m) => m['type'] === 'lldbInput')).toBe(false);
    const result = await session.wait();

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('(lldb) frame variable\n');
    expect(sentMessages.find((m) => m['type'] === 'lldb')).toMatchObject({
      pid: 4321,
      stdin: Buffer.from('bt\n').toString('base64'),
      keepStdinOpen: true,
    });
    const input = sentMessages.filter((m) => m['type'] === 'lldbInput');
    expect(input[0]).toEqual({
      type: 'lldbInput',
      id: input[1]!['id'],
      sequence: 0,
      data: Buffer.from('frame variable\n').toString('base64'),
    });
    expect(input[1]).toEqual({ type: 'lldbInput', id: input[0]!['id'], sequence: 1, close: true });
    client.disconnect();
  });

  it('terminates the session on stop, so a dropped session does not leave the app stopped', async () => {
    const client = await connect();

    const session = client.lldb([], { bundleId: 'com.example.app', keepStdinOpen: true });
    const request = () => sentMessages.find((m) => m['type'] === 'lldb');
    await new Promise((resolve) => setImmediate(resolve));
    session.stop();

    expect(sentMessages).toContainEqual({ type: 'simctlTerminate', id: request()!['id'] });
    client.disconnect();
  });
});
