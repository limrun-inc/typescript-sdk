import AndroidCreate, { androidDeviceSelection } from './create';

jest.mock('../../lib/config', () => ({
  ...jest.requireActual('../../lib/config'),
  registerCreatedInstance: jest.fn(),
}));

test('Android 15 tablet selection maps to separate OS and model fields', () => {
  expect(androidDeviceSelection('15', 'tablet')).toEqual({
    clues: [{ kind: 'OSVersion', osVersion: '15' }],
    model: 'tablet',
  });
});

test('Android create exposes supported OS versions and models', () => {
  expect(AndroidCreate.flags['os-version'].options).toEqual(['14', '15']);
  expect(AndroidCreate.flags.model.options).toEqual(['phone', 'tablet']);
});

function setup(flags: Record<string, unknown>) {
  const create = jest
    .fn()
    .mockResolvedValue({ metadata: { id: 'android_test' }, status: { state: 'ready' } });
  const command = Object.assign(Object.create(AndroidCreate.prototype), {
    parse: async () => ({
      flags: { connect: false, open: false, 'persist-ttl': '72h', ...flags },
    }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    consoleStreamUrl: () => 'https://console.example.test/stream/android_test',
    info: jest.fn(),
    output: jest.fn(),
  });
  Object.defineProperty(command, 'client', { value: { androidInstances: { create } } });
  return { command, create };
}

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
