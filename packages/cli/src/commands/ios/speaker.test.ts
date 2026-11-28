import path from 'path';
import IosSpeaker from './speaker';
import { getIosInstanceClient } from '../../lib/instance-client-factory';

jest.mock('../../lib/instance-client-factory', () => ({ getIosInstanceClient: jest.fn() }));

beforeEach(() => jest.clearAllMocks());

function setup(args: Record<string, unknown>, flags: Record<string, unknown> = {}) {
  const client = {
    startSpeakerRecording: jest.fn().mockResolvedValue('spk-1'),
    stopSpeakerRecording: jest
      .fn()
      .mockResolvedValue('https://instance.example/files?name=speaker_spk-1.wav'),
  };
  const disconnect = jest.fn();
  jest.mocked(getIosInstanceClient).mockResolvedValue({ client, disconnect } as never);
  const outputResult = jest.fn();
  const command = Object.assign(Object.create(IosSpeaker.prototype), {
    parse: async () => ({ args, flags }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    resolveIosInstance: () => ({ id: 'ios_test' }),
    outputResult,
  });
  Object.defineProperty(command, 'client', { value: {} });
  return { command, client, disconnect, outputResult };
}

test('start begins a speaker recording and disconnects', async () => {
  const { command, client, disconnect, outputResult } = setup({ action: 'start' });
  await command.run();
  expect(client.startSpeakerRecording).toHaveBeenCalledWith({});
  expect(outputResult).toHaveBeenCalledWith(
    { ok: true, instanceId: 'ios_test', speakerRecording: true, recordingId: 'spk-1' },
    'Speaker recording started: spk-1',
  );
  expect(disconnect).toHaveBeenCalledTimes(1);
});

test('stop downloads the WAV file', async () => {
  const { command, client, outputResult } = setup(
    { action: 'stop', recordingId: 'run-1' },
    { output: 'out/run.wav' },
  );
  await command.run();
  const localPath = path.resolve('out/run.wav');
  expect(client.stopSpeakerRecording).toHaveBeenCalledWith('run-1', { localPath });
  expect(outputResult).toHaveBeenCalledWith(
    { ok: true, instanceId: 'ios_test', speakerRecording: false, localPath },
    `Speaker recording saved to ${localPath}`,
  );
});

test('a failed stop still disconnects', async () => {
  const { command, client, disconnect } = setup({ action: 'stop' });
  client.stopSpeakerRecording.mockRejectedValue(new Error('no speaker recording is active'));
  await expect(command.run()).rejects.toThrow('no speaker recording is active');
  expect(disconnect).toHaveBeenCalledTimes(1);
});
