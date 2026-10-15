import { Parser } from '@oclif/core';
import GradleBuild from './build';

function setup(additionalFiles?: string[]) {
  const sync = jest.fn().mockResolvedValue({ bytesSent: 12 });
  const gradlebuild = jest.fn().mockReturnValue({ detach: async () => 'build_test' });
  const command = Object.assign(Object.create(GradleBuild.prototype), {
    parse: async () => ({
      args: { path: '/project' },
      flags: { 'additional-file': additionalFiles, detach: true },
    }),
    setParsedFlags: jest.fn(),
    withAuth: jest.fn(async (run: () => Promise<void>) => run()),
    resolveGradleTargetOrCreate: jest.fn(async () => ({ id: 'gradle_test' })),
    resolveGradleClient: async () => ({ sync, gradlebuild }),
    info: jest.fn(),
    isJsonEnabled: () => true,
    outputJson: jest.fn(),
    consoleBuildUrl: () => 'https://console.limrun.com',
    error: (message: string): never => {
      throw new Error(message);
    },
  });
  return { command, sync, gradlebuild };
}

test('parses repeated additional files without consuming the project path', async () => {
  const parsed = await Parser.parse(
    [
      '--additional-file',
      '/credentials/npmrc=.npmrc',
      '--additional-file',
      '/credentials/netrc=.netrc',
      './app',
    ],
    { flags: GradleBuild.flags, args: GradleBuild.args },
  );
  expect(parsed.flags['additional-file']).toEqual(['/credentials/npmrc=.npmrc', '/credentials/netrc=.netrc']);
  expect(parsed.args.path).toBe('./app');
});

test('syncs additional credentials before starting the build', async () => {
  const { command, sync, gradlebuild } = setup(['/credentials/npmrc=.npmrc', '/credentials/netrc=.netrc']);
  await command.run();
  expect(sync).toHaveBeenCalledWith(
    '/project',
    expect.objectContaining({
      additionalFiles: [
        { localPath: '/credentials/npmrc', remotePath: '.npmrc' },
        { localPath: '/credentials/netrc', remotePath: '.netrc' },
      ],
    }),
  );
  expect(sync.mock.invocationCallOrder[0]).toBeLessThan(gradlebuild.mock.invocationCallOrder[0]!);
});

test.each(['missing-separator', '=remote', '/local='])(
  'rejects malformed mapping %s before authentication or instance creation',
  async (value) => {
    const { command, sync, gradlebuild } = setup([value]);
    await expect(command.run()).rejects.toThrow('Invalid --additional-file value');
    expect(command.withAuth).not.toHaveBeenCalled();
    expect(command.resolveGradleTargetOrCreate).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    expect(gradlebuild).not.toHaveBeenCalled();
  },
);

test('a failed credential sync does not start the build', async () => {
  const { command, sync, gradlebuild } = setup(['/missing/npmrc=.npmrc']);
  sync.mockRejectedValue(new Error('ENOENT'));
  await expect(command.run()).rejects.toThrow('ENOENT');
  expect(gradlebuild).not.toHaveBeenCalled();
});
