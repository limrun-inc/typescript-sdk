const sentMessages: Record<string, unknown>[] = [];
// When > 0, tapElement replies with the server's fail-fast "matched nothing"
// error and decrements; the client-side scroll search retries against this.
let tapElementMissesRemaining = 0;

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

      if (message.type === 'setElementValue') {
        process.nextTick(() => {
          this['emit'](
            'message',
            Buffer.from(
              JSON.stringify({
                type: 'setElementValueResult',
                id: message.id,
                elementLabel: 'Field',
              }),
            ),
          );
        });
      } else if (message.type === 'deviceInfo') {
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
          this['emit']('message', Buffer.from(JSON.stringify({ type: 'typeTextResult', id: message.id })));
        });
      } else if (message.type === 'tapElement') {
        const miss = tapElementMissesRemaining > 0;
        if (miss) tapElementMissesRemaining -= 1;
        process.nextTick(() => {
          this['emit'](
            'message',
            Buffer.from(
              JSON.stringify(
                miss ?
                  {
                    type: 'tapElementResult',
                    id: message.id,
                    error:
                      'Element for selector matched nothing in the accessibility tree. Fix the selector...',
                  }
                : {
                    type: 'tapElementResult',
                    id: message.id,
                    elementLabel: 'Submit',
                    elementType: 'Button',
                    method: message.activate ?? 'touch',
                  },
              ),
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
    tapElementMissesRemaining = 0;
  });

  it('serializes typeText with its original payload shape', async () => {
    const client = await connect();
    await client.typeText('hello', true);

    const sent = sentMessages.find((message) => message['type'] === 'typeText');
    expect(sent).toMatchObject({ type: 'typeText', text: 'hello', pressEnter: true });
    expect(sent).not.toHaveProperty('strategy');
    expect(sent).not.toHaveProperty('requireFocus');

    client.disconnect();
  });

  it('sends requireFocus only when explicitly false', async () => {
    const client = await connect();

    await client.typeText('hello', false, { requireFocus: false });
    expect(sentMessages.find((message) => message['type'] === 'typeText')).toMatchObject({
      requireFocus: false,
    });

    sentMessages.length = 0;
    await client.typeText('hello', false, { requireFocus: true });
    expect(sentMessages.find((message) => message['type'] === 'typeText')).not.toHaveProperty('requireFocus');

    client.disconnect();
  });

  it('targets the focused element when setElementValue is called without a selector', async () => {
    const client = await connect();

    await client.setElementValue('fast text');
    const focusedSent = sentMessages.find((message) => message['type'] === 'setElementValue');
    expect(focusedSent).toMatchObject({ focused: true });
    expect(focusedSent).not.toHaveProperty('selector');

    sentMessages.length = 0;
    await client.setElementValue('fast text', { AXUniqueId: 'field' });
    const selectorSent = sentMessages.find((message) => message['type'] === 'setElementValue');
    expect(selectorSent).toMatchObject({ selector: { AXUniqueId: 'field' } });
    expect(selectorSent).not.toHaveProperty('focused');

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

  it('rejects an absent selector immediately without scrollSearch', async () => {
    const client = await connect();
    tapElementMissesRemaining = 99;

    await expect(client.tapElement({ AXLabel: 'Ghost' })).rejects.toThrow(/matched nothing/);
    expect(sentMessages.filter((message) => message['type'] === 'scroll')).toHaveLength(0);

    client.disconnect();
  });

  it('scroll-searches an absent selector client-side until it materializes', async () => {
    const client = await connect();
    // First attempt + two paged attempts miss; the third page hits.
    tapElementMissesRemaining = 3;

    const result = await client.tapElement({ AXLabel: 'Row 900' }, { scrollSearch: true });
    expect(result.elementLabel).toBe('Submit');

    const scrolls = sentMessages.filter((message) => message['type'] === 'scroll');
    const attempts = sentMessages.filter((message) => message['type'] === 'tapElement');
    expect(scrolls).toHaveLength(3);
    expect(attempts).toHaveLength(4);
    // Page size derives from the device info the client caches on connect.
    expect(scrolls[0]).toMatchObject({ direction: 'down', pixels: Math.round(844 * 0.6) });

    client.disconnect();
  });

  it('gives up scroll search after the page budget and says so', async () => {
    const client = await connect();
    tapElementMissesRemaining = 99;

    await expect(client.tapElement({ AXLabel: 'Ghost' }, { scrollSearch: true })).rejects.toThrow(
      /after client-side scroll search/,
    );
    // 3 pages down, 6 back up; one attempt before paging plus one per page.
    expect(sentMessages.filter((message) => message['type'] === 'scroll')).toHaveLength(9);
    expect(sentMessages.filter((message) => message['type'] === 'tapElement')).toHaveLength(10);

    client.disconnect();
  }, 15_000);

  it('stops scroll search when the total timeoutMs budget runs out', async () => {
    const client = await connect();
    tapElementMissesRemaining = 99;

    // The budget covers the first attempt plus roughly one 300ms page; the
    // remaining pages must be skipped instead of running the full sweep.
    await expect(
      client.tapElement({ AXLabel: 'Ghost' }, { scrollSearch: true, timeoutMs: 400 }),
    ).rejects.toThrow(/after client-side scroll search/);
    expect(sentMessages.filter((message) => message['type'] === 'scroll').length).toBeLessThan(5);

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
