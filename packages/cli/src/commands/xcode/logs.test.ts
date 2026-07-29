import XcodeLogs from './logs';

describe('Xcode build log ownership', () => {
  afterEach(() => jest.restoreAllMocks());

  test.each([true, false])('uses the attached sandbox for an iOS target, cached=%s', async (cached) => {
    const sandboxUrl = 'https://example.test/v1/xcode_instances/sandbox_test';
    const listBuildLogs = jest.fn(async () => [
      {
        id: 'build-1',
        status: 'SUCCEEDED',
        exitCode: 0,
        downloadUrl: 'https://logs.test/1',
      },
    ]);
    const getIos = jest.fn(async () => ({ status: { sandbox: { xcode: { url: sandboxUrl } } } }));
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Build succeeded\n'));
    const outputJson = jest.fn();
    const command = Object.assign(Object.create(XcodeLogs.prototype), {
      parse: async () => ({ args: { execId: 'build-1' }, flags: { json: true } }),
      setParsedFlags: jest.fn(),
      withAuth: async (run: () => Promise<void>) => run(),
      resolveXcodeTarget: async () => ({
        type: 'ios',
        id: 'ios_test',
        ...(cached && { sandboxXcodeUrl: sandboxUrl }),
      }),
      resolveXcodeClient: jest.fn(),
      outputJson,
    });
    Object.defineProperty(command, 'client', {
      value: { xcodeInstances: { listBuildLogs }, iosInstances: { get: getIos } },
    });

    await command.run();

    expect(listBuildLogs).toHaveBeenCalledWith('sandbox_test');
    expect(getIos).toHaveBeenCalledTimes(cached ? 0 : 1);
    expect(command.resolveXcodeClient).not.toHaveBeenCalled();
    expect(outputJson).toHaveBeenCalledWith(expect.objectContaining({ source: 'persisted' }));
  });
});
