import XcodeLogs from './logs';
import GradleLogs from '../gradle/logs';

describe.each([
  ['Xcode', XcodeLogs],
  ['Gradle', GradleLogs],
] as const)('%s logs without an exec ID', (_name, LogsCommand) => {
  test.each([false, true])('selects the latest build with follow=%s', async (follow) => {
    const observeBuildLogs = jest.fn(async () => ({
      execId: 'build-2',
      status: follow ? 'SUCCEEDED' : 'RUNNING',
      ...(follow && { exitCode: 0 }),
    }));
    const outputJson = jest.fn();
    const command = Object.assign(Object.create(LogsCommand.prototype), {
      parse: async () => ({ args: {}, flags: { json: true, follow } }),
      setParsedFlags: jest.fn(),
      withAuth: async (run: () => Promise<void>) => run(),
      resolveXcodeTarget: async () => ({ type: 'xcode', id: 'sandbox_test' }),
      resolveGradleTarget: () => ({ id: 'gradle_test' }),
      resolveXcodeClient: async () => ({ observeBuildLogs }),
      resolveGradleClient: async () => ({ observeBuildLogs }),
      outputJson,
    });

    await command.run();

    expect(observeBuildLogs).toHaveBeenCalledTimes(1);
    expect(observeBuildLogs).toHaveBeenCalledWith('latest', {
      follow,
      onEvent: expect.any(Function),
    });
    expect(outputJson).toHaveBeenCalledWith(
      expect.objectContaining({
        execId: 'build-2',
        status: follow ? 'SUCCEEDED' : 'RUNNING',
      }),
    );
  });
});

describe('Xcode build log ownership', () => {
  afterEach(() => jest.restoreAllMocks());

  test('reads persisted logs from the Xcode target itself', async () => {
    const listBuildLogs = jest.fn(async () => [
      {
        id: 'build-1',
        status: 'SUCCEEDED',
        exitCode: 0,
        downloadUrl: 'https://logs.test/1',
      },
    ]);
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Build succeeded\n'));
    const outputJson = jest.fn();
    const command = Object.assign(Object.create(XcodeLogs.prototype), {
      parse: async () => ({ args: { execId: 'build-1' }, flags: { json: true } }),
      setParsedFlags: jest.fn(),
      withAuth: async (run: () => Promise<void>) => run(),
      resolveXcodeTarget: async () => ({ type: 'xcode', id: 'sandbox_test' }),
      resolveXcodeClient: jest.fn(),
      outputJson,
    });
    Object.defineProperty(command, 'client', { value: { xcodeInstances: { listBuildLogs } } });

    await command.run();

    expect(listBuildLogs).toHaveBeenCalledWith('sandbox_test');
    expect(command.resolveXcodeClient).not.toHaveBeenCalled();
    expect(outputJson).toHaveBeenCalledWith(expect.objectContaining({ source: 'persisted' }));
  });
});
