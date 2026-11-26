import path from 'path';
import MacosRecord from './record';

function setup(args: Record<string, unknown>, flags: Record<string, unknown>) {
  const client = {
    startRecording: jest.fn().mockResolvedValue('rec-1'),
    stopRecording: jest.fn().mockResolvedValue('https://instance.example/files?name=recording_rec-1.mp4'),
  };
  const resolveMacosClient = jest.fn(async () => ({ id: 'macos_test', client }));
  const outputResult = jest.fn();
  const command = Object.assign(Object.create(MacosRecord.prototype), {
    parse: async () => ({ args, flags: { quality: 5, persist: false, ...flags } }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    resolveMacosClient,
    outputResult,
  });
  return { command, client, resolveMacosClient, outputResult };
}

test('start begins a recording with the given ID and quality', async () => {
  const { command, client, outputResult } = setup({ action: 'start', recordingId: 'run-1' }, { quality: 8 });
  await command.run();
  expect(client.startRecording).toHaveBeenCalledWith({ recordingId: 'run-1', quality: 8 });
  expect(outputResult).toHaveBeenCalledWith(
    expect.objectContaining({ instanceId: 'macos_test', recordingId: 'rec-1', persist: false }),
    'Recording started: rec-1',
  );
});

test.each([
  [{ persist: true }, true],
  [{ persist: true, 'persist-ttl': '24h' }, { ttlSeconds: 86400 }],
])('start with %j persists the recording as %j', async (flags, persist) => {
  const { command, client } = setup({ action: 'start' }, flags);
  await command.run();
  expect(client.startRecording).toHaveBeenCalledWith({ quality: 5, persist });
});

test('stop downloads the MP4 and has the instance upload it', async () => {
  const { command, client, outputResult } = setup(
    { action: 'stop' },
    { output: 'out/run.mp4', 'presigned-url': 'https://bucket.example/put' },
  );
  await command.run();
  const localPath = path.resolve('out/run.mp4');
  expect(client.stopRecording).toHaveBeenCalledWith(undefined, {
    localPath,
    presignedUrl: 'https://bucket.example/put',
  });
  expect(outputResult).toHaveBeenCalledWith(
    { ok: true, instanceId: 'macos_test', recording: false, localPath, uploaded: true },
    `Recording saved to ${localPath}`,
  );
});

test.each([
  [{ action: 'start' }, { 'persist-ttl': '24h' }, '--persist-ttl requires --persist.'],
  [{ action: 'stop' }, { persist: true }, '--persist only applies to the `start` action.'],
])('rejects %j with %j before reaching the instance', async (args, flags, message) => {
  const { command, resolveMacosClient } = setup(args, flags);
  await expect(command.run()).rejects.toThrow(message);
  expect(resolveMacosClient).not.toHaveBeenCalled();
});
