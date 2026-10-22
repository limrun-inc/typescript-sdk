import { Parser } from '@oclif/core';
import IosRecord from './ios/record';
import AndroidRecord from './android/record';
import { getIosInstanceClient, getAndroidInstanceClient } from '../lib/instance-client-factory';

jest.mock('../lib/instance-client-factory', () => ({
  getIosInstanceClient: jest.fn(),
  getAndroidInstanceClient: jest.fn(),
}));

beforeEach(() => jest.clearAllMocks());

for (const Command of [IosRecord, AndroidRecord]) {
  describe(Command.name, () => {
    async function run(argv: string[]) {
      const parsed = await Parser.parse(argv, { flags: Command.flags, args: Command.args });
      const client = {
        startRecordingSession: jest.fn().mockResolvedValue(parsed.args.recordingId ?? 'generated-id'),
        stopRecordingSession: jest.fn().mockResolvedValue('https://example.test/recording.mp4'),
      };
      const disconnect = jest.fn();
      for (const factory of [getIosInstanceClient, getAndroidInstanceClient]) {
        jest.mocked(factory).mockResolvedValue({ client, disconnect } as never);
      }
      const command = Object.assign(Object.create(Command.prototype), {
        parse: async () => parsed,
        setParsedFlags: jest.fn(),
        withAuth: async (operation: () => Promise<void>) => operation(),
        resolveIosInstance: () => ({ id: parsed.flags.id }),
        resolveAndroidInstance: () => ({ id: parsed.flags.id }),
        outputResult: jest.fn(),
        error: (message: string) => {
          throw new Error(message);
        },
      });
      Object.defineProperty(command, 'client', { value: {} });
      await command.run();
      return { command, client, disconnect };
    }

    test.each([undefined, 'run-1'])('start accepts ID %p independently of --id', async (recordingId) => {
      const { command, client, disconnect } = await run([
        'start',
        ...(recordingId ? [recordingId] : []),
        '--id',
        'instance-1',
        '--json',
      ]);
      expect(client.startRecordingSession).toHaveBeenCalledWith(expect.objectContaining({ recordingId }));
      expect(command.outputResult).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId: 'instance-1',
          recordingId: recordingId ?? 'generated-id',
          recording: true,
        }),
        expect.any(String),
      );
      expect(disconnect).toHaveBeenCalledTimes(1);
    });

    test.each([undefined, 'run-1'])('stop leaves ID %p selection to the device', async (recordingId) => {
      const { client, disconnect } = await run([
        'stop',
        ...(recordingId ? [recordingId] : []),
        '--id',
        'instance-1',
        '-o',
        '/tmp/run.mp4',
      ]);
      expect(client.stopRecordingSession).toHaveBeenCalledWith(recordingId, {
        localPath: '/tmp/run.mp4',
        presignedUrl: undefined,
      });
      expect(disconnect).toHaveBeenCalledTimes(1);
    });
  });
}
