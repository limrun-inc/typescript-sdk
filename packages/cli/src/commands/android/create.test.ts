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

test('--tunnel names the persistent tunnel in the instance spec', async () => {
  const create = jest
    .fn()
    .mockResolvedValue({ metadata: { id: 'android_test' }, status: { state: 'ready' } });
  const command = Object.assign(Object.create(AndroidCreate.prototype), {
    parse: async () => ({
      flags: { connect: false, open: false, 'persist-ttl': '72h', tunnel: 'staging' },
    }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    consoleStreamUrl: () => 'https://console.example.test/stream/android_test',
    info: jest.fn(),
    output: jest.fn(),
  });
  Object.defineProperty(command, 'client', { value: { androidInstances: { create } } });

  await command.run();

  expect(create).toHaveBeenCalledWith(expect.objectContaining({ spec: { tunnel: 'staging' } }));
});
