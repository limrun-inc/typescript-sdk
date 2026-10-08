import AndroidRecord from './android/record';
import IosRecord from './ios/record';
import {
  ensureDaemonSession,
  getAndroidInstanceClient,
  getIosInstanceClient,
  sendSessionCommand,
} from '../lib/instance-client-factory';

jest.mock('../lib/instance-client-factory', () => ({
  ensureDaemonSession: jest.fn(),
  getAndroidInstanceClient: jest.fn(),
  getIosInstanceClient: jest.fn(),
  sendSessionCommand: jest.fn(),
}));

beforeEach(() => jest.clearAllMocks());

describe.each([AndroidRecord, IosRecord])('%s segmented recording', (Command) => {
  function setup(action: string, extraFlags = {}) {
    const client = {
      startRecording: jest.fn().mockResolvedValue(undefined),
      stopRecordingSegments: jest.fn().mockResolvedValue([{ localPath: '/tmp/parts/segment-000000.mp4' }]),
    };
    const disconnect = jest.fn();
    jest.mocked(ensureDaemonSession).mockResolvedValue(true);
    jest.mocked(getAndroidInstanceClient).mockResolvedValue({ client, disconnect } as never);
    jest.mocked(getIosInstanceClient).mockResolvedValue({ client, disconnect } as never);
    const command = Object.assign(Object.create(Command.prototype), {
      parse: async () => ({
        args: { action },
        flags: { segments: true, quality: 5, output: '/tmp/parts', ...extraFlags },
      }),
      setParsedFlags: jest.fn(),
      withAuth: async (run: () => Promise<void>) => run(),
      resolveAndroidInstance: () => ({ id: 'android_test' }),
      resolveIosInstance: () => ({ id: 'ios_test' }),
      log: jest.fn(),
      outputJson: jest.fn(),
      error: (message: string) => {
        throw new Error(message);
      },
    });
    Object.defineProperty(command, 'client', { value: {} });
    return { command, client, disconnect };
  }

  it('bypasses an older daemon for start and preserves persistence options', async () => {
    const { command, client, disconnect } = setup('start', { persist: true, 'persist-ttl': '24h' });
    await command.run();
    expect(client.startRecording).toHaveBeenCalledWith(
      expect.objectContaining({ segmentOnRotation: true, quality: 5, persist: { ttlSeconds: 86400 } }),
    );
    expect(sendSessionCommand).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('stops into a directory on a fresh connection and returns JSON when requested', async () => {
    const { command, client, disconnect } = setup('stop', { json: true });
    await command.run();
    expect(client.stopRecordingSegments).toHaveBeenCalledWith({ localDirectory: '/tmp/parts' });
    expect(command.outputJson).toHaveBeenCalledWith([{ localPath: '/tmp/parts/segment-000000.mp4' }]);
    expect(sendSessionCommand).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('rejects a single upload URL before stopping the recording', async () => {
    const { command, client } = setup('stop', { 'presigned-url': 'https://example.com/upload' });
    await expect(command.run()).rejects.toThrow('--segments cannot use a single --presigned-url');
    expect(client.stopRecordingSegments).not.toHaveBeenCalled();
  });
});
