import MacosCreate from './create';

jest.mock('../../lib/config', () => ({
  ...jest.requireActual('../../lib/config'),
  registerCreatedInstance: jest.fn(),
}));

function setup(flags: Record<string, unknown>) {
  const instance = {
    metadata: { id: 'macos_test', createdAt: '2026-11-26T10:00:00Z' },
    spec: { region: 'us-west2' },
    status: { state: 'ready', apiUrl: 'https://macos.example/v1/macos_test', token: 't' },
  };
  const create = jest.fn().mockResolvedValue(instance);
  const guest = {
    restoreSnapshot: jest.fn().mockResolvedValue({ phase: 'restored', key: 'my-mac' }),
    startRecording: jest.fn().mockResolvedValue('rec-1'),
    startAppLogCapture: jest.fn().mockResolvedValue(undefined),
    startEventCapture: jest.fn().mockResolvedValue(undefined),
    startPerformanceCapture: jest.fn().mockResolvedValue(undefined),
  };
  const createClient = jest.fn().mockResolvedValue(guest);
  const info = jest.fn();
  const command = Object.assign(Object.create(MacosCreate.prototype), {
    parse: async () => ({
      args: {},
      flags: { record: false, events: false, perf: false, 'persist-ttl': '72h', ...flags },
    }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    consoleStreamUrl: () => 'https://console.example/stream/macos_test',
    info,
    output: jest.fn(),
  });
  Object.defineProperty(command, 'client', { value: { macosInstances: { create, createClient } } });
  return { command, create, createClient, guest, info };
}

test('--snapshot-key grants the asset permissions and restores once the instance is ready', async () => {
  const { command, create, guest, info } = setup({ 'snapshot-key': 'my-mac' });
  await command.run();
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      spec: {
        role: {
          permissions: [
            'asset:name/my-mac*:read',
            'asset:name/my-mac:create',
            'asset:name/my-mac:upload',
            'asset:name/my-mac:update',
          ],
        },
      },
    }),
  );
  expect(guest.restoreSnapshot).toHaveBeenCalledWith(expect.objectContaining({ key: 'my-mac' }));
  expect(info).toHaveBeenCalledWith(expect.stringMatching(/^Disk snapshot: restored my-mac in \d+s\.$/));
});

test('--snapshot-restore-keys restores from those names in order', async () => {
  const { command, guest } = setup({ 'snapshot-key': 'pr-51', 'snapshot-restore-keys': 'pr-51,main' });
  await command.run();
  expect(guest.restoreSnapshot).toHaveBeenCalledWith(
    expect.objectContaining({ key: 'pr-51', restoreKeys: ['pr-51', 'main'] }),
  );
});

test('creates no guest client without a snapshot or captures', async () => {
  const { command, create, createClient } = setup({});
  await command.run();
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ spec: { role: { permissions: [] } } }));
  expect(createClient).not.toHaveBeenCalled();
});

test('starts the persisted captures with the TTL', async () => {
  const { command, guest } = setup({
    record: true,
    events: true,
    perf: true,
    'app-logs': 'com.example.app',
    'persist-ttl': '24h',
  });
  await command.run();
  const persist = { ttlSeconds: 86400 };
  expect(guest.startRecording).toHaveBeenCalledWith(expect.objectContaining({ persist }));
  expect(guest.startAppLogCapture).toHaveBeenCalledWith({ bundleId: 'com.example.app', persist });
  expect(guest.startEventCapture).toHaveBeenCalledWith({ persist });
  expect(guest.startPerformanceCapture).toHaveBeenCalledWith({ ttlSeconds: 86400 });
});

test('a bad --persist-ttl fails before the instance is created', async () => {
  const { command, create } = setup({ record: true, 'persist-ttl': 'soon' });
  await expect(command.run()).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
});

test('--tunnel names the private tunnel in the instance spec', async () => {
  const { command, create } = setup({ tunnel: 'staging' });
  await command.run();
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ spec: { role: { permissions: [] }, tunnel: 'staging' } }),
  );
});

test('--tunnel-header adds the headers to the instance spec', async () => {
  const { command, create } = setup({ tunnel: 'staging', 'tunnel-header': ['X-Run-Id: run-4812'] });
  await command.run();
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      spec: { role: { permissions: [] }, tunnel: 'staging', tunnelHeaders: { 'X-Run-Id': 'run-4812' } },
    }),
  );
});

test('omits tunnelHeaders without --tunnel-header', async () => {
  const { command, create } = setup({ tunnel: 'staging' });
  await command.run();
  expect(create.mock.calls[0][0].spec).not.toHaveProperty('tunnelHeaders');
});

test('a malformed --tunnel-header fails before the instance is created', async () => {
  const { command, create } = setup({ 'tunnel-header': ['X-Run-Id run-4812'] });
  await expect(command.run()).rejects.toThrow("--tunnel-header #1 must look like 'Name: value'.");
  expect(create).not.toHaveBeenCalled();
});

test('--reuse-if-exists asks the guest to restore, which keeps a disk that already restored', async () => {
  const { command, guest, info } = setup({ 'snapshot-key': 'my-mac', 'reuse-if-exists': true });
  guest.restoreSnapshot.mockImplementation(async ({ onProgress }) => {
    const earlier = { phase: 'restored', key: 'my-mac' };
    onProgress?.(earlier);
    return earlier;
  });
  await command.run();
  expect(guest.restoreSnapshot).toHaveBeenCalledWith(expect.objectContaining({ key: 'my-mac' }));
  expect(info).toHaveBeenCalledWith(
    'Disk snapshot: this instance already restored my-mac; its disk is kept as it is.',
  );
});
