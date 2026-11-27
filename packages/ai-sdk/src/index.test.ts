import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => {
  const ready = { status: { state: 'ready', apiUrl: 'https://device', token: 'tok' } };
  const iosClient = {
    performActions: vi.fn(async () => ({ results: [] })),
    screenshot: vi.fn(async () => ({ base64: 'aW1n', width: 390, height: 844 })),
    elementTreeRaw: vi.fn(async () => '[{"AXLabel":"Search"}]'),
    disconnect: vi.fn(),
  };
  const iosInstances = { get: vi.fn(async () => ready), create: vi.fn(), delete: vi.fn() };
  const androidInstances = { get: vi.fn(async () => ready), create: vi.fn(), delete: vi.fn() };
  return { iosClient, iosInstances, androidInstances };
});

vi.mock('@limrun/api', () => ({
  default: class {
    iosInstances = api.iosInstances;
    androidInstances = api.androidInstances;
  },
  createInstanceClient: vi.fn(),
  Ios: { createInstanceClient: vi.fn(async () => api.iosClient) },
}));

const { limrunTools } = await import('./index');

const call = { toolCallId: 'call-1', messages: [] };

beforeEach(() => vi.clearAllMocks());

describe('limrunTools', () => {
  it('converts MCP-shaped ios-use actions to one performActions batch', async () => {
    const tools = limrunTools();
    await tools['ios-use'].execute!(
      {
        instanceId: 'ios_1',
        actions: [
          { kind: 'tap', selector: { AXLabel: 'Search' } },
          { kind: 'tap', x: 10, y: 20 },
          { kind: 'type', text: 'weather', pressEnter: true },
          { kind: 'scroll', scrollDirection: 'down', scrollAmount: 300 },
          { kind: 'wait', duration: 500 },
        ],
      },
      call,
    );

    expect(api.iosClient.performActions).toHaveBeenCalledWith([
      { type: 'tapElement', selector: { AXLabel: 'Search' } },
      { type: 'tap', x: 10, y: 20 },
      { type: 'typeText', text: 'weather', pressEnter: true },
      { type: 'scroll', direction: 'down', pixels: 300, coordinate: undefined, momentum: undefined },
      { type: 'wait', durationMs: 500 },
    ]);
    expect(api.iosClient.disconnect).toHaveBeenCalled();
  });

  it('rejects a tap without a selector or coordinates and still disconnects', async () => {
    const tools = limrunTools();
    await expect(
      tools['ios-use'].execute!({ instanceId: 'ios_1', actions: [{ kind: 'tap', x: 10 }] }, call),
    ).rejects.toThrow('tap needs a selector, or both x and y.');
    expect(api.iosClient.performActions).not.toHaveBeenCalled();
    expect(api.iosClient.disconnect).toHaveBeenCalled();
  });

  it('sends the screenshot to the model as an image', async () => {
    const tools = limrunTools();
    const tool = tools['ios-screenshot-and-element-tree'];
    const output = await tool.execute!({ instanceId: 'ios_1' }, call);

    expect(tool.toModelOutput!({ toolCallId: 'call-1', input: { instanceId: 'ios_1' }, output })).toEqual({
      type: 'content',
      value: [
        {
          type: 'text',
          text: JSON.stringify({ width: 390, height: 844, elementTree: '[{"AXLabel":"Search"}]' }),
        },
        { type: 'file', mediaType: 'image/jpeg', data: { type: 'data', data: 'aW1n' } },
      ],
    });
  });

  it('maps create apps to URL and asset-name initial assets', async () => {
    api.iosInstances.create.mockResolvedValue({
      metadata: { id: 'ios_1', createdAt: 'now' },
      status: { state: 'ready' },
    });
    const tools = limrunTools();
    const result = await tools['create-ios-simulator'].execute!(
      { apps: ['my-app', 'https://example.com/app.zip'] },
      call,
    );

    expect(api.iosInstances.create).toHaveBeenCalledWith({
      wait: true,
      metadata: { labels: { 'created-by': 'ai-sdk' } },
      spec: {
        initialAssets: [
          { kind: 'App', source: 'AssetName', assetName: 'my-app' },
          { kind: 'App', source: 'URL', url: 'https://example.com/app.zip' },
        ],
      },
    });
    expect(result).toEqual({ instanceId: 'ios_1', state: 'ready', createdAt: 'now' });
  });

  it('routes delete-instance by ID prefix and rejects unknown IDs', async () => {
    const tools = limrunTools();
    await tools['delete-instance'].execute!({ instanceId: 'android_1' }, call);

    expect(api.androidInstances.delete).toHaveBeenCalledWith('android_1');
    expect(api.iosInstances.delete).not.toHaveBeenCalled();
    await expect(tools['delete-instance'].execute!({ instanceId: 'xcode_1' }, call)).rejects.toThrow(
      'Expected an ID that starts with "ios_" or "android_".',
    );
  });

  it('fails device tools when the instance is not ready', async () => {
    api.iosInstances.get.mockResolvedValueOnce({ status: { state: 'creating' } } as never);
    const tools = limrunTools();
    await expect(
      tools['ios-open-url'].execute!({ instanceId: 'ios_1', url: 'https://x' }, call),
    ).rejects.toThrow('Instance ios_1 is creating, not ready.');
  });
});
