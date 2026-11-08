import Limrun from '../src';
import { createServeSimHost, deviceHostCatalog, type DeviceHostInstance } from '../src/serve-sim-host';
import { createInstanceClient as createIosClient } from '../src/ios-client';
import { createInstanceClient as createAndroidClient } from '../src/instance-client';

jest.mock('../src/ios-client');
jest.mock('../src/instance-client');

async function fixture() {
  let sequence = 0;
  const records = new Map<string, DeviceHostInstance>();
  const allocations = new Map<string, DeviceHostInstance>();
  const requests: Array<{ url: URL; method: string; body: any }> = [];
  const deleted: string[] = [];
  let loseResponse = false;
  let refuseDelete = false;
  let refuseWatch = false;
  let initialState = 'ready';
  const fetcher = jest.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, body });
    if (url.pathname.endsWith('/access_tokens'))
      return refuseWatch ? Response.json({}, { status: 403 }) : Response.json({ token: 'watch-token' });
    const match = /\/v1\/(ios|android)_instances(?:\/([^/]+))?$/.exec(url.pathname)!;
    const platform = match[1]!;
    const id = match[2];
    if (!id && method === 'GET') {
      const selector = url.searchParams.get('labelSelector')!;
      const [label, value] = selector.split('=');
      return Response.json(
        url.searchParams.has('startingAfter') ?
          []
        : [...records.values()].filter(
            (item) => item.metadata.id.startsWith(platform + '_') && item.metadata.labels?.[label!] === value,
          ),
      );
    }
    if (!id) {
      const slot = body.metadata.labels['host-slot'];
      let instance = allocations.get(slot);
      if (!instance) {
        const newId = `${platform}_${++sequence}`;
        instance = {
          metadata: { ...body.metadata, id: newId },
          spec: body.spec,
          status: {
            state: initialState,
            apiUrl: `https://instance.test/${newId}/api`,
            token: `token-${newId}`,
            endpointWebSocketUrl: `wss://instance.test/${newId}/stream`,
            adbWebSocketUrl: `wss://instance.test/${newId}/adb`,
          },
        } as DeviceHostInstance;
        allocations.set(slot, instance);
        records.set(newId, instance);
        if (loseResponse) throw new Error('Response lost');
      }
      return Response.json(instance);
    }
    if (method === 'DELETE') {
      if (refuseDelete) return Response.json({}, { status: 503 });
      deleted.push(id);
      records.delete(id);
      return new Response(null, { status: 204 });
    }
    return records.has(id) ? Response.json(records.get(id)) : Response.json({}, { status: 404 });
  });
  let active = ['outer', 'inner'];
  const runtime = {
    keepAlive: jest.fn(),
    disconnect: jest.fn(),
    screenshot: jest.fn(async () => ({ base64: 'aW1hZ2U=', dataUri: 'data:image/png;base64,aW1hZ2U=' })),
    getFoldState: jest.fn(async () => ({
      displays: ['outer', 'inner'].map((id) => ({ id, active: active.includes(id) })),
    })),
    screenshotDisplay: jest.fn(async (display: string) => ({
      base64: Buffer.from(display).toString('base64'),
    })),
    simctl: jest.fn(() => ({
      wait: async () => ({ stdout: Buffer.from('ios'), stderr: Buffer.from(''), code: 0 }),
    })),
    adbShell: jest.fn(async () => ({ stdout: 'android', stderr: '', exitCode: 0 })),
  };
  jest
    .mocked(createIosClient)
    .mockResolvedValue(runtime as unknown as Awaited<ReturnType<typeof createIosClient>>);
  jest
    .mocked(createAndroidClient)
    .mockResolvedValue(runtime as unknown as Awaited<ReturnType<typeof createAndroidClient>>);
  const errors = jest.fn();
  const host = await createServeSimHost({
    client: new Limrun({
      apiKey: 'organization-key',
      baseURL: 'https://api.test',
      fetch: fetcher,
      maxRetries: 0,
    }),
    owner: { label: 'host-owner', value: 'installation' },
    allocationLabel: 'host-slot',
    displayName: 'Test host',
    region: '',
    hardTimeout: '10m',
    inactivityTimeout: '2m',
    maxConcurrentSessions: 1,
    onError: errors,
  });
  return {
    host,
    records,
    requests,
    deleted,
    runtime,
    errors,
    loseResponse: () => {
      loseResponse = true;
    },
    refuseDelete: (value: boolean) => {
      refuseDelete = value;
    },
    refuseWatch: () => {
      refuseWatch = true;
    },
    active: (value: string[]) => {
      active = value;
    },
    initialState: (value: string) => {
      initialState = value;
    },
  };
}

it('retries an uncertain allocation with the same labels and refuses a different target', async () => {
  const f = await fixture();
  try {
    f.loseResponse();
    await expect(f.host.open({ platform: 'ios', model: 'iphone' })).rejects.toThrow();
    await expect(f.host.open({ platform: 'android', model: 'phone' })).rejects.toThrow('previous device');
    const session = await f.host.open({ platform: 'ios', model: 'iphone' });
    expect(f.records.size).toBe(1);
    expect(session.id).toBe('ios_1');
    const creates = f.requests.filter((r) => r.method === 'POST');
    expect(creates[0]!.body).toEqual(creates[1]!.body);
    expect(session.agentEnv).toEqual({
      LIM_IOS_INSTANCE_URL: 'https://instance.test/ios_1/api',
      LIM_IOS_INSTANCE_TOKEN: 'token-ios_1',
    });
  } finally {
    await f.host.close();
  }
});

it('retains failed deletions in the capacity limit and allows retry', async () => {
  const f = await fixture();
  try {
    const session = await f.host.open({ platform: 'android', model: 'tablet' });
    expect(session.agentEnv['LIM_ANDROID_INSTANCE_ADB_URL']).toContain(session.id);
    f.refuseDelete(true);
    await expect(f.host.remove(session.id)).rejects.toThrow();
    expect((await f.host.stop()).map((item) => item.id)).toEqual([session.id]);
    await expect(f.host.open({ platform: 'ios', model: 'ipad' })).rejects.toThrow('Close a device');
    f.refuseDelete(false);
    await f.host.remove(session.id);
    expect((await f.host.open({ platform: 'ios', model: 'ipad' })).id).not.toBe(session.id);
  } finally {
    await f.host.close();
  }
});

it('recovers only this owner and releases externally terminated instances', async () => {
  const f = await fixture();
  try {
    f.records.set('ios_old', {
      metadata: {
        createdAt: '2026-11-08T00:00:00Z',
        organizationId: 'org_test',
        id: 'ios_old',
        labels: { 'host-owner': 'installation' },
      },
      spec: { region: 'useb', inactivityTimeout: '2m' },
      status: { state: 'ready' },
    } as DeviceHostInstance);
    f.records.set('ios_other', {
      metadata: {
        createdAt: '2026-11-08T00:00:00Z',
        organizationId: 'org_test',
        id: 'ios_other',
        labels: { 'host-owner': 'other' },
      },
      spec: { region: 'useb', inactivityTimeout: '2m' },
      status: { state: 'ready' },
    } as DeviceHostInstance);
    await f.host.list();
    expect(f.deleted).toEqual(['ios_old']);
    expect(f.records.has('ios_other')).toBe(true);
    const session = await f.host.open({ platform: 'ios', model: 'iphone' });
    f.records.delete(session.id);
    expect(await f.host.list()).toEqual([]);
    expect(f.runtime.disconnect).toHaveBeenCalledTimes(1);
    await expect(f.host.screenshot(session.id)).rejects.toThrow('ended');
  } finally {
    await f.host.close();
  }
});

it('selects the active Duo panel, using outer while both panels are active', async () => {
  const f = await fixture();
  try {
    const session = await f.host.open({ platform: 'ios', model: 'iphone-duo' });
    for (const [active, expected] of [
      [['outer', 'inner'], 'outer'],
      [['inner'], 'inner'],
      [['outer'], 'outer'],
      [[], 'outer'],
    ] as const) {
      f.active([...active]);
      expect(Buffer.from(await f.host.screenshot(session.id)).toString()).toBe(expected);
    }
    expect(f.runtime.screenshot).not.toHaveBeenCalled();
  } finally {
    await f.host.close();
  }
});

it.each(['ios', 'android'] as const)(
  'mints only watch credentials for %s previews and fails closed',
  async (platform) => {
    const f = await fixture();
    try {
      const session = await f.host.open(
        platform === 'ios' ? { platform, model: 'iphone' } : { platform, model: 'phone' },
      );
      const path =
        platform === 'ios' ?
          `/vendor/serve-sim/helper/${session.id}/webrtc/offer`
        : `/vendor/serve-emu/webrtc/offer?device=${session.id}`;
      f.refuseWatch();
      const response = await fetch(f.host.origin + path, {
        method: 'POST',
        headers: f.host.headers,
        body: JSON.stringify({ sdp: 'v=0' }),
      });
      expect(response.ok).toBe(false);
      expect(f.requests.at(-1)!.body).toEqual({
        permissions: [`${platform}:${session.id}:watch`],
        ttlSeconds: 300,
      });
      expect(
        (
          await fetch(f.host.origin + '/vendor/serve-sim/helper/unowned/api/screenshot', {
            method: 'POST',
            headers: f.host.headers,
          })
        ).status,
      ).toBe(404);
    } finally {
      await f.host.close();
    }
  },
);

it.each(['ios', 'android'] as const)('runs %s commands only for the selected instance', async (platform) => {
  const f = await fixture();
  try {
    const session = await f.host.open(
      platform === 'ios' ? { platform, model: 'iphone' } : { platform, model: 'phone' },
    );
    const command = platform === 'ios' ? 'xcrun' : 'adb';
    const args =
      platform === 'ios' ?
        ['simctl', 'pbcopy', session.id]
      : ['-s', session.id, 'shell', 'settings', 'get', 'system', 'font_scale'];
    expect((await f.host.run(command, args, { stdin: 'text' })).stdout).toBe(platform);
    if (platform === 'ios')
      expect(f.runtime.simctl).toHaveBeenCalledWith(['pbcopy', 'booted'], { stdin: 'text' });
    else expect(f.runtime.adbShell).toHaveBeenCalledWith('sh', ['-c', 'settings get system font_scale']);
    await expect(
      f.host.run(
        command,
        args.map((arg) => (arg === session.id ? 'unowned' : arg)),
      ),
    ).rejects.toThrow('ended');
    expect(Buffer.from(await f.host.screenshot(session.id)).toString()).toBe('image');
  } finally {
    await f.host.close();
  }
});

it('cleans up failed readiness and reports deletion failures', async () => {
  const f = await fixture();
  try {
    f.initialState('terminated');
    f.refuseDelete(true);
    await expect(f.host.open({ platform: 'ios', model: 'iphone' })).rejects.toThrow('failed to start');
    expect(f.errors).toHaveBeenCalledWith('delete', 'ios_1', expect.any(Error));
    f.refuseDelete(false);
    await f.host.remove('ios_1');
    expect(f.deleted).toContain('ios_1');
  } finally {
    await f.host.close();
  }
});

it('serializes concurrent allocations so the instance limit cannot be exceeded', async () => {
  const f = await fixture();
  try {
    const results = await Promise.allSettled([
      f.host.open({ platform: 'ios', model: 'iphone' }),
      f.host.open({ platform: 'android', model: 'phone' }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(f.records.size).toBe(1);
  } finally {
    await f.host.close();
  }
});

it('cancels readiness and deletes the allocation', async () => {
  const f = await fixture();
  try {
    f.initialState('creating');
    const abort = new AbortController();
    const opening = f.host.open({ platform: 'ios', model: 'iphone' }, abort.signal);
    // Let the mocked HTTP response allocate before cancelling the readiness wait.
    const check = setInterval(() => {
      if (f.records.size) abort.abort();
    }, 1);
    try {
      await expect(opening).rejects.toThrow();
    } finally {
      clearInterval(check);
    }
    expect(f.deleted).toEqual(['ios_1']);
    expect(await f.host.list()).toEqual([]);
  } finally {
    await f.host.close();
  }
});

it('keeps instances alive and stops heartbeats when released', async () => {
  const f = await fixture();
  try {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const session = await f.host.open({ platform: 'ios', model: 'iphone' });
    jest.advanceTimersByTime(60_000);
    expect(f.runtime.keepAlive).toHaveBeenCalledTimes(2);
    await f.host.remove(session.id);
    jest.advanceTimersByTime(60_000);
    expect(f.runtime.keepAlive).toHaveBeenCalledTimes(2);
  } finally {
    jest.useRealTimers();
    await f.host.close();
  }
});

it('translates emulator GPS fixes to Android mock-provider commands without swapping coordinates', async () => {
  const f = await fixture();
  try {
    const session = await f.host.open({ platform: 'android', model: 'phone' });
    expect(await f.host.run('adb', ['-s', session.id, 'emu', 'geo', 'fix', '-122.4194', '37.7749'])).toEqual({
      stdout: '',
      stderr: '',
      code: 0,
    });
    expect(f.runtime.adbShell.mock.calls).toEqual([
      ['appops', ['set', 'com.android.shell', 'android:mock_location', 'allow']],
      [
        'cmd',
        [
          'location',
          'providers',
          'add-test-provider',
          'gps',
          '--requiresSatellite',
          '--supportsAltitude',
          '--supportsSpeed',
          '--supportsBearing',
        ],
      ],
      ['cmd', ['location', 'providers', 'set-test-provider-enabled', 'gps', 'true']],
      [
        'cmd',
        [
          'location',
          'providers',
          'set-test-provider-location',
          'gps',
          '--location',
          '37.7749,-122.4194',
          '--accuracy',
          '1',
        ],
      ],
    ]);
    f.runtime.adbShell.mockClear();
    for (const coordinates of [
      ['181', '0'],
      ['0', '-91'],
      ['NaN', '0'],
      ['', '0'],
      ['0', '1; reboot'],
      ['0'],
    ]) {
      expect((await f.host.run('adb', ['-s', session.id, 'emu', 'geo', 'fix', ...coordinates])).code).toBe(1);
    }
    expect(f.runtime.adbShell).not.toHaveBeenCalled();
  } finally {
    await f.host.close();
  }
});

it.each([0, 1, 2, 3])(
  'stops location setup when step %i fails and reports the command failure',
  async (step) => {
    const f = await fixture();
    try {
      const session = await f.host.open({ platform: 'android', model: 'phone' });
      for (let i = 0; i < step; i++)
        f.runtime.adbShell.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
      f.runtime.adbShell.mockResolvedValueOnce({ stdout: '', stderr: 'Permission denied', exitCode: 1 });
      expect(await f.host.run('adb', ['-s', session.id, 'emu', 'geo', 'fix', '0', '0'])).toEqual({
        stdout: '',
        stderr: 'Permission denied',
        code: 1,
      });
      expect(f.runtime.adbShell).toHaveBeenCalledTimes(step + 1);
    } finally {
      await f.host.close();
    }
  },
);

it.each([0, 1, 2, 3])(
  'forwards Android absolute rotation %i through the existing ADB shell API',
  async (rotation) => {
    const f = await fixture();
    try {
      const session = await f.host.open({ platform: 'android', model: 'phone' });
      await f.host.run('adb', [
        '-s',
        session.id,
        'shell',
        'cmd',
        'window',
        'user-rotation',
        'lock',
        String(rotation),
      ]);
      expect(f.runtime.adbShell).toHaveBeenCalledWith('sh', [
        '-c',
        `cmd window user-rotation lock ${rotation}`,
      ]);
    } finally {
      await f.host.close();
    }
  },
);

it.each(deviceHostCatalog)('opens the catalog target $name through its platform API', async (target) => {
  const f = await fixture();
  try {
    const session = await f.host.open(target);
    const request = f.requests.find((request) => request.method === 'POST')!;
    expect(request.url.pathname).toBe(`/v1/${target.platform}_instances`);
    expect(request.body.spec.model).toBe(target.model);
    expect(session.platform).toBe(target.platform);
    expect(session.model).toBe(target.model);
  } finally {
    await f.host.close();
  }
});

it('rejects malformed commands and platform mismatches without executing device commands', async () => {
  const f = await fixture();
  try {
    const session = await f.host.open({ platform: 'ios', model: 'iphone' });
    const commands: Array<[string, string[]]> = [
      ['xcrun', ['simctl', 'pbcopy']],
      ['xcrun', ['simctl', '', session.id]],
      ['xcrun', ['other-tool', 'pbcopy', session.id]],
      ['adb', ['-s']],
      ['adb', ['-s', session.id, 'shell', 'reboot']],
      ['adb', ['shell', session.id, 'reboot']],
      ['sh', ['-c', session.id]],
    ];
    for (const [command, args] of commands) expect((await f.host.run(command, args)).code).toBe(127);
    expect(f.runtime.simctl).not.toHaveBeenCalled();
    expect(f.runtime.adbShell).not.toHaveBeenCalled();
  } finally {
    await f.host.close();
  }
});
