import { BaseCommand } from '../base-command';
import { APIError } from '@limrun/api';
import { setSecretEnvCommand } from './set-secret-env-command';

test.each(['xcode', 'gradle', 'ios', 'android'] as const)(
  '%s saves bindings and permissions atomically, retrying ETag conflicts',
  async (platform) => {
    const Command = setSecretEnvCommand(platform) as unknown as new (
      ...args: ConstructorParameters<typeof BaseCommand>
    ) => BaseCommand;
    const command = new Command([], {} as never);
    const id = 'instance';
    const live = jest
      .fn()
      .mockResolvedValueOnce({
        data: {
          spec: { envFromSecret: { OLD: 'name/old' }, role: { permissions: ['asset:name/source:read'] } },
          status: { state: 'ready' },
        },
        response: new Response(null, { headers: { etag: '"1"' } }),
      })
      .mockResolvedValueOnce({
        data: {
          spec: {
            envFromSecret: { OLD: 'name/old', CONCURRENT: 'name/concurrent' },
            role: { permissions: ['asset:name/source:read', 'secret:name/concurrent:read'] },
          },
          status: { state: 'ready' },
        },
        response: new Response(null, { headers: { etag: '"2"' } }),
      });
    const update = jest
      .fn()
      .mockRejectedValueOnce(APIError.generate(412, {}, 'changed', new Headers()))
      .mockResolvedValue(undefined);
    Object.assign(command, {
      parse: async () => ({ argv: ['NPM_TOKEN=team/npm'], flags: { unset: ['OLD'] } }),
      withAuth: async (fn: () => Promise<void>) => fn(),
      resolveXcodeTarget: async () => ({ id }),
      resolveGradleTarget: () => ({ id }),
      resolveIosInstance: () => ({ id }),
      resolveAndroidInstance: () => ({ id }),
      outputResult: jest.fn(),
    });
    Object.defineProperty(command, 'client', {
      value: { [`${platform}Instances`]: { get: () => ({ withResponse: live }), update } },
    });
    await command.run();
    expect(update).toHaveBeenLastCalledWith(id, {
      ifMatch: '"2"',
      spec: {
        envFromSecret: { CONCURRENT: 'name/concurrent', NPM_TOKEN: 'name/team/npm' },
        role: {
          permissions: ['asset:name/source:read', 'secret:name/concurrent:read', 'secret:name/team/npm:read'],
        },
      },
    });
  },
);
