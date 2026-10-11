import AndroidRecord from './record';
import {
  ensureDaemonSession,
  getAndroidInstanceClient,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

jest.mock('../../lib/instance-client-factory', () => ({
  ensureDaemonSession: jest.fn(),
  getAndroidInstanceClient: jest.fn(),
  sendSessionCommand: jest.fn(),
}));

beforeEach(() => jest.clearAllMocks());

test.each([true, false])('forwards recording options with daemon=%s', async (daemon) => {
  const client = { startRecording: jest.fn().mockResolvedValue(undefined) };
  const disconnect = jest.fn();
  jest.mocked(getAndroidInstanceClient).mockResolvedValue({ client, disconnect } as never);
  jest.mocked(ensureDaemonSession).mockResolvedValue(daemon);
  const command = Object.assign(Object.create(AndroidRecord.prototype), {
    parse: async () => ({
      args: { action: 'start' },
      flags: {
        id: 'android_test',
        quality: 8,
        persist: true,
        'persist-ttl': '1h',
        'touch-indicators': false,
      },
    }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    resolveAndroidInstance: () => ({ id: 'android_test' }),
    log: jest.fn(),
  });
  Object.defineProperty(command, 'client', { value: {} });
  await command.run();
  const options = { quality: 8, persist: { ttlSeconds: 3600 }, touchIndicators: false };
  if (daemon) {
    expect(sendSessionCommand).toHaveBeenCalledWith('android_test', 'start-recording', [options]);
    expect(getAndroidInstanceClient).not.toHaveBeenCalled();
  } else {
    expect(client.startRecording).toHaveBeenCalledWith(options);
    expect(disconnect).toHaveBeenCalledTimes(1);
  }
});

test.each([
  [['start'], true],
  [['start', '--no-touch-indicators'], false],
  [['start', '--touch-indicators'], true],
] as const)('parses %s', async (argv, expected) => {
  const { Parser } = await import('@oclif/core');
  const parsed = await Parser.parse([...argv], { flags: AndroidRecord.flags, args: AndroidRecord.args });
  expect(parsed.flags['touch-indicators']).toBe(expected);
});
