import XcodeTest from './commands/xcode/test';

jest.mock('./lib/config', () => ({
  ...jest.requireActual('./lib/config'),
  loadLastXcodeInstance: jest.fn(() => null),
  registerCreatedInstance: jest.fn(),
}));

test('xcode test --without-building never creates a sandbox, which would have nothing built', async () => {
  const create = jest.fn();
  const command = new XcodeTest([], {} as never);
  Object.assign(command, {
    parse: async () => ({ args: {}, flags: { 'without-building': true } }),
    withAuth: async (fn: () => Promise<void>) => fn(),
    info: jest.fn(),
  });
  Object.defineProperty(command, 'client', {
    value: { xcodeInstances: { create }, iosInstances: { create } },
  });

  await expect(command.run()).rejects.toThrow(
    '--without-building reruns the tests a live Xcode sandbox already built',
  );
  expect(create).not.toHaveBeenCalled();
});
