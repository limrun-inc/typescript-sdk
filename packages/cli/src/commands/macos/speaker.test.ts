import path from 'path';
import MacosSpeaker from './speaker';

function setup(args: Record<string, unknown>, flags: Record<string, unknown> = {}) {
  const client = {
    startSpeakerRecording: jest.fn().mockResolvedValue('spk-1'),
    stopSpeakerRecording: jest
      .fn()
      .mockResolvedValue('https://instance.example/files?name=speaker_spk-1.wav'),
  };
  const resolveMacosClient = jest.fn(async () => ({ id: 'macos_test', client }));
  const outputResult = jest.fn();
  const command = Object.assign(Object.create(MacosSpeaker.prototype), {
    parse: async () => ({ args, flags }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    resolveMacosClient,
    outputResult,
  });
  return { command, client, resolveMacosClient, outputResult };
}

test('start begins a speaker recording with the given ID', async () => {
  const { command, client, outputResult } = setup({ action: 'start', recordingId: 'run-1' });
  await command.run();
  expect(client.startSpeakerRecording).toHaveBeenCalledWith({ recordingId: 'run-1' });
  expect(outputResult).toHaveBeenCalledWith(
    { ok: true, instanceId: 'macos_test', speakerRecording: true, recordingId: 'spk-1' },
    'Speaker recording started: spk-1',
  );
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
    { ok: true, instanceId: 'macos_test', speakerRecording: false, localPath },
    `Speaker recording saved to ${localPath}`,
  );
});

test('stop without --output saves a timestamped WAV in the current directory', async () => {
  const { command, client } = setup({ action: 'stop' });
  await command.run();
  const [, saveTo] = client.stopSpeakerRecording.mock.calls[0];
  expect(path.dirname(saveTo.localPath)).toBe(process.cwd());
  expect(path.basename(saveTo.localPath)).toMatch(/^speaker_.*\.wav$/);
});

test('--output on start is refused before reaching the instance', async () => {
  const { command, resolveMacosClient } = setup({ action: 'start' }, { output: 'x.wav' });
  await expect(command.run()).rejects.toThrow('--output only applies to the `stop` action.');
  expect(resolveMacosClient).not.toHaveBeenCalled();
});
