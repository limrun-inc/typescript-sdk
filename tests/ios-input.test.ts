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
      } else if (message.type === 'typeText') {
        process.nextTick(() => {
          this['emit'](
            'message',
            Buffer.from(
              JSON.stringify({
                type: 'typeTextResult',
                id: message.id,
                // Echo warning fields only for the hid-warning fixture text
                ...(message.text === 'unfocused' ?
                  { warning: 'no focused accessibility element', usedStrategy: 'hid' }
                : { usedStrategy: 'ax' }),
              }),
            ),
          );
        });
      } else if (message.type === 'tapElement') {
        process.nextTick(() => {
          this['emit'](
            'message',
            Buffer.from(
              JSON.stringify({
                type: 'tapElementResult',
                id: message.id,
                elementLabel: 'Submit',
                elementType: 'Button',
                method: message.activate ?? 'touch',
              }),
            ),
          );
        });
      } else if (message.type === 'scroll') {
        process.nextTick(() => {
          this['emit']('message', Buffer.from(JSON.stringify({ type: 'scrollResult', id: message.id })));
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

async function connect() {
  const { createInstanceClient } = await import('../src/ios-client');
  return createInstanceClient({
    apiUrl: 'https://example.test/v1/ios_123/api',
    token: 'token',
    logLevel: 'none',
  });
}

describe('iOS input serialization', () => {
  beforeEach(() => {
    sentMessages.length = 0;
  });

  it('omits strategy and requireFocus from legacy typeText calls so old servers see the old payload', async () => {
    const client = await connect();
    await client.typeText('hello', true);

    const sent = sentMessages.find((message) => message['type'] === 'typeText');
    expect(sent).toMatchObject({ type: 'typeText', text: 'hello', pressEnter: true });
    expect(sent).not.toHaveProperty('strategy');
    expect(sent).not.toHaveProperty('requireFocus');

    client.disconnect();
  });

  it('serializes typing strategy options and surfaces the warning result', async () => {
    const client = await connect();
    const result = await client.typeText('unfocused', false, { strategy: 'hid', requireFocus: true });

    expect(sentMessages.find((message) => message['type'] === 'typeText')).toMatchObject({
      strategy: 'hid',
      requireFocus: true,
    });
    expect(result).toEqual({ warning: 'no focused accessibility element', usedStrategy: 'hid' });

    client.disconnect();
  });

  it('serializes tapElement activation and surfaces the method result', async () => {
    const client = await connect();

    const legacy = await client.tapElement({ AXLabel: 'Submit' });
    const legacySent = sentMessages.find((message) => message['type'] === 'tapElement');
    expect(legacySent).not.toHaveProperty('activate');
    expect(legacy.method).toBe('touch');

    sentMessages.length = 0;
    const ax = await client.tapElement({ AXLabel: 'Submit' }, { activate: 'ax' });
    expect(sentMessages.find((message) => message['type'] === 'tapElement')).toMatchObject({
      activate: 'ax',
    });
    expect(ax.method).toBe('ax');

    client.disconnect();
  });

  it('serializes scroll coordinates', async () => {
    const client = await connect();
    await client.scroll('down', 300, { coordinate: [120, 500] });

    expect(sentMessages.find((message) => message['type'] === 'scroll')).toMatchObject({
      direction: 'down',
      pixels: 300,
      coordinate: [120, 500],
    });

    client.disconnect();
  });
});
