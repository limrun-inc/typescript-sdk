export {};

const sentMessages: Record<string, unknown>[] = [];
let activeSocket: { emitServerMessage: (message: Record<string, unknown>) => void } | undefined;
let failLaunch = false;

jest.mock('ws', () => {
  const { EventEmitter } = require('events');

  class MockWebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;

    readyState = MockWebSocket.OPEN;

    constructor() {
      super();
      activeSocket = this as unknown as { emitServerMessage: (message: Record<string, unknown>) => void };
      process.nextTick(() => this['emit']('open'));
    }

    emitServerMessage(message: Record<string, unknown>): void {
      this['emit']('message', Buffer.from(JSON.stringify(message)));
    }

    send(data: string, callback?: (err?: Error) => void): void {
      const message = JSON.parse(data);
      sentMessages.push(message);
      if (message.type === 'watchApp') {
        process.nextTick(() => {
          this.emitServerMessage({
            type: 'watchAppResult',
            id: message.id,
            payload: { packageName: message.packageName },
          });
        });
      } else if (message.type === 'unwatchApp') {
        process.nextTick(() => {
          this.emitServerMessage({
            type: 'unwatchAppResult',
            id: message.id,
            payload: {},
          });
        });
      } else if (message.type === 'launchApp') {
        process.nextTick(() => {
          if (failLaunch) {
            this.emitServerMessage({
              type: 'launchAppResult',
              id: message.id,
              error: { code: 'app_not_found', message: 'Package not installed: ' + message.packageName },
            });
          } else {
            this.emitServerMessage({
              type: 'launchAppResult',
              id: message.id,
              payload: { packageName: message.packageName },
            });
          }
        });
      } else if (message.type === 'terminateApp') {
        process.nextTick(() => {
          this.emitServerMessage({
            type: 'terminateAppResult',
            id: message.id,
            payload: { packageName: message.packageName },
          });
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

describe('Android launchApp / terminateApp', () => {
  beforeEach(() => {
    sentMessages.length = 0;
    failLaunch = false;
  });

  async function createClient() {
    const { createInstanceClient } = await import('../src/instance-client');
    return createInstanceClient({
      apiUrl: 'https://example.test/v1/android_123/api',
      token: 'token',
      logLevel: 'none',
    });
  }

  it('launches by package name with a mode and resolves the package name', async () => {
    const client = await createClient();

    const result = await client.launchApp('com.example.app', 'RelaunchIfRunning');

    const request = sentMessages.find((message) => message['type'] === 'launchApp');
    expect(request).toMatchObject({
      type: 'launchApp',
      packageName: 'com.example.app',
      mode: 'RelaunchIfRunning',
    });
    expect(request!['execId']).toBeUndefined();
    expect(result).toEqual({ packageName: 'com.example.app' });
    client.disconnect();
  });

  it('registers an execId and invokes onExit with logs and crash details', async () => {
    const client = await createClient();

    let received: { logs: string[]; info: Record<string, unknown> } | undefined;
    const exited = new Promise<void>((resolve) => {
      void client.launchApp('com.example.app', {
        onExit: (logs, info) => {
          received = { logs, info: info as unknown as Record<string, unknown> };
          resolve();
        },
      });
    });

    // Wait for the launch request to be sent and resolved.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const request = sentMessages.find((message) => message['type'] === 'launchApp');
    expect(typeof request!['execId']).toBe('string');

    activeSocket!.emitServerMessage({
      type: 'appExit',
      execId: request!['execId'],
      packageName: 'com.example.app',
      reason: 'crash',
      crash: {
        processName: 'com.example.app',
        pid: 4242,
        shortMsg: 'java.lang.RuntimeException',
        longMsg: 'java.lang.RuntimeException: boom',
        stackTrace: 'java.lang.RuntimeException: boom\n\tat com.example.app.MainActivity.onCreate',
        timeMillis: 1750000000000,
      },
      logs: ['08-05 12:00:00.000  4242  4242 E AndroidRuntime: FATAL EXCEPTION: main'],
    });

    await exited;
    expect(received!.logs).toEqual([
      '08-05 12:00:00.000  4242  4242 E AndroidRuntime: FATAL EXCEPTION: main',
    ]);
    expect(received!.info).toMatchObject({
      packageName: 'com.example.app',
      reason: 'crash',
      crash: { pid: 4242, shortMsg: 'java.lang.RuntimeException' },
    });
    client.disconnect();
  });

  it('drops the onExit registration when the launch fails', async () => {
    failLaunch = true;
    const client = await createClient();

    const onExit = jest.fn();
    await expect(client.launchApp('com.example.app', { onExit })).rejects.toThrow(
      'Package not installed: com.example.app',
    );

    const request = sentMessages.find((message) => message['type'] === 'launchApp');
    activeSocket!.emitServerMessage({
      type: 'appExit',
      execId: request!['execId'],
      packageName: 'com.example.app',
      reason: 'exit',
      logs: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onExit).not.toHaveBeenCalled();
    client.disconnect();
  });

  it('watchApp registers a standalone watch and fires onExit for the deeplink case', async () => {
    const client = await createClient();

    let received: { logs: string[]; info: Record<string, unknown> } | undefined;
    const exited = new Promise<void>((resolve) => {
      void client.watchApp('com.example.app', (logs, info) => {
        received = { logs, info: info as unknown as Record<string, unknown> };
        resolve();
      });
    });
    await new Promise((r) => setTimeout(r, 10));

    const request = sentMessages.find((message) => message['type'] === 'watchApp');
    expect(request).toMatchObject({ type: 'watchApp', packageName: 'com.example.app' });
    expect(typeof request!['execId']).toBe('string');
    // No launchApp was sent; the app is started externally (e.g. deeplink).
    expect(sentMessages.find((message) => message['type'] === 'launchApp')).toBeUndefined();

    activeSocket!.emitServerMessage({
      type: 'appExit',
      execId: request!['execId'],
      packageName: 'com.example.app',
      reason: 'crash',
      crash: {
        processName: 'com.example.app',
        pid: 7,
        shortMsg: 'boom',
        longMsg: '',
        stackTrace: 'x',
        timeMillis: 1,
      },
      logs: ['fatal'],
    });
    await exited;
    expect(received!.info).toMatchObject({ reason: 'crash', packageName: 'com.example.app' });
    expect(received!.logs).toEqual(['fatal']);
    client.disconnect();
  });

  it('watchApp stop() unregisters the callback and sends unwatchApp', async () => {
    const client = await createClient();

    const onExit = jest.fn();
    const watch = await client.watchApp('com.example.app', onExit);
    await watch.stop();

    expect(sentMessages.find((message) => message['type'] === 'unwatchApp')).toMatchObject({
      type: 'unwatchApp',
      execId: watch.execId,
    });
    activeSocket!.emitServerMessage({
      type: 'appExit',
      execId: watch.execId,
      packageName: 'com.example.app',
      reason: 'exit',
      logs: [],
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(onExit).not.toHaveBeenCalled();
    client.disconnect();
  });

  it('serializes terminateApp and resolves void', async () => {
    const client = await createClient();

    await expect(client.terminateApp('com.example.app')).resolves.toBeUndefined();
    expect(sentMessages.find((message) => message['type'] === 'terminateApp')).toMatchObject({
      type: 'terminateApp',
      packageName: 'com.example.app',
    });
    client.disconnect();
  });
});
