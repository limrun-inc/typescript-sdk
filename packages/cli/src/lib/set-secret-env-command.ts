import { Flags } from '@oclif/core';
import { APIError } from '@limrun/api';
import { BaseCommand } from '../base-command';
import { parseSecretEnv, permissionCovers, secretReadPermissions } from './secret-env';

export function setSecretEnvCommand(platform: 'xcode' | 'gradle' | 'ios' | 'android'): typeof BaseCommand {
  return class SetSecretEnv extends BaseCommand {
    static summary = `Save secret-backed environment variables on a ${platform} instance`;
    static description =
      'Bindings apply to subsequent commands. Values are fetched by the workload using its delegated secret read permissions. Repeat NAME=secret/name to merge bindings; use --unset NAME to remove one, or --clear to remove all. Removing a binding preserves delegated permissions.';
    static strict = false;
    static examples = [
      `<%= config.bin %> ${platform} set env-from-secret NPM_TOKEN=my/secret`,
      `<%= config.bin %> ${platform} set env-from-secret --unset NPM_TOKEN`,
    ];
    static flags = {
      ...BaseCommand.baseFlags,
      id: Flags.string({ description: 'Instance ID. Defaults to the current target.' }),
      unset: Flags.string({
        description: 'Remove a saved environment binding.',
        multiple: true,
        multipleNonGreedy: true,
      }),
      clear: Flags.boolean({ description: 'Remove all saved bindings before applying new ones.' }),
    };
    async run(): Promise<void> {
      const { argv, flags } = await this.parse(SetSecretEnv);
      this.setParsedFlags(flags);
      const additions = parseSecretEnv(argv as string[]) ?? {};
      const remove = flags.unset ?? [];
      if (!Object.keys(additions).length && !remove.length && !flags.clear)
        this.error('Provide NAME=secret/name, --unset NAME, or --clear.');
      for (const key of remove)
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key))
          this.error('Invalid --unset environment variable name.');
      await this.withAuth(async () => {
        const target =
          platform === 'xcode' ? await this.resolveXcodeTarget(flags.id)
          : platform === 'gradle' ? this.resolveGradleTarget(flags.id)
          : platform === 'ios' ? this.resolveIosInstance(flags.id)
          : this.resolveAndroidInstance(flags.id);
        const resources = {
          xcode: this.client.xcodeInstances,
          gradle: this.client.gradleInstances,
          ios: this.client.iosInstances,
          android: this.client.androidInstances,
        };
        const instances = resources[platform];
        for (let attempt = 0; attempt < 3; attempt++) {
          const { data: instance, response } = await instances.get(target.id).withResponse();
          const etag = response.headers.get('etag');
          const role = instance.spec.role;
          if (!etag || !role || instance.status.state === 'terminated')
            this.error('Select a live instance with an editable role.');
          const envFromSecret: Record<string, string> = {
            ...(flags.clear ? {} : instance.spec.envFromSecret),
            ...additions,
          };
          for (const key of remove) delete envFromSecret[key];
          if (Object.keys(envFromSecret).length > 64) this.error('At most 64 secret bindings are supported.');
          const required = secretReadPermissions(additions).filter(
            (permission) => !role.permissions.some((granted) => permissionCovers(granted, permission)),
          );
          try {
            await instances.update(target.id, {
              ifMatch: etag,
              spec: {
                envFromSecret,
                ...(required.length && {
                  role: { permissions: [...new Set([...role.permissions, ...required])] },
                }),
              },
            });
            this.outputResult(
              { instanceId: target.id, envFromSecret },
              `Updated secret environment bindings on ${target.id}.`,
            );
            return;
          } catch (error) {
            if (!(error instanceof APIError) || error.status !== 412 || attempt === 2) throw error;
          }
        }
      });
    }
  };
}
