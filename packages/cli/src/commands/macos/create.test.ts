import MacosCreate from './create';

jest.mock('../../lib/config', () => ({
  ...jest.requireActual('../../lib/config'),
  registerCreatedInstance: jest.fn(),
}));

/**
 * The API's clock as the create response reports it, and when the instance was created on that
 * clock. By default the instance is created as the request arrives, with the API's clock in step.
 */
interface ApiTimes {
  apiNow?: number | null;
  createdAt?: number;
}

function setup(flags: Record<string, unknown>, { apiNow = Date.now(), createdAt }: ApiTimes = {}) {
  const instance = {
    metadata: { id: 'macos_test', createdAt: new Date(createdAt ?? apiNow ?? Date.now()).toISOString() },
    spec: { region: 'us-west2' },
    status: { state: 'ready', apiUrl: 'https://macos.example/v1/macos_test', token: 't' },
  };
  const headers = new Headers(apiNow === null ? {} : { date: new Date(apiNow).toUTCString() });
  const create = jest.fn(() => ({ withResponse: async () => ({ data: instance, response: { headers } }) }));
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

const reuse = { 'snapshot-key': 'my-mac', 'reuse-if-exists': true };
const HOUR = 60 * 60 * 1000;

test('--reuse-if-exists keeps the disk of an instance that already existed', async () => {
  const { command, guest, info } = setup(reuse, { createdAt: Date.now() - HOUR });
  await command.run();
  expect(guest.restoreSnapshot).not.toHaveBeenCalled();
  expect(info).toHaveBeenCalledWith(
    'Reused macOS instance macos_test; its disk is kept and no snapshot is restored.',
  );
});

test('--reuse-if-exists restores into an instance this command created', async () => {
  const { command, guest } = setup(reuse);
  await command.run();
  expect(guest.restoreSnapshot).toHaveBeenCalledWith(expect.objectContaining({ key: 'my-mac' }));
});

test.each([
  ['behind', -HOUR],
  ['ahead of', HOUR],
])('tells new from reused on the API clock when it runs an hour %s this one', async (_, offset) => {
  const apiNow = Date.now() + offset;
  const created = setup(reuse, { apiNow });
  await created.command.run();
  expect(created.guest.restoreSnapshot).toHaveBeenCalled();
  const reused = setup(reuse, { apiNow, createdAt: apiNow - 10_000 });
  await reused.command.run();
  expect(reused.guest.restoreSnapshot).not.toHaveBeenCalled();
});

test('treats the instance as reused when the response carries no Date header', async () => {
  const { command, guest } = setup(reuse, { apiNow: null });
  await command.run();
  expect(guest.restoreSnapshot).not.toHaveBeenCalled();
});
