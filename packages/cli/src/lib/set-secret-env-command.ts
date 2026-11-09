import { Flags } from '@oclif/core';
import { APIError } from '@limrun/api';
import { BaseCommand } from '../base-command';
import { parseSecretEnv, parseSecretFiles, permissionCovers, secretReadPermissions } from './secret-env';

export function setSecretEnvCommand(
  platform: 'xcode' | 'gradle' | 'ios' | 'android',
  kind: 'env' | 'file' = 'env',
): typeof BaseCommand {
  const field = kind === 'file' ? 'fileFromSecret' : 'envFromSecret';
  const parse = kind === 'file' ? parseSecretFiles : parseSecretEnv;
  return class SetSecretEnv extends BaseCommand {
    static summary = `Save secret-backed ${
      kind === 'file' ? 'files' : 'environment variables'
    } on the ${platform} instance`;
    static description =
      (kind === 'file' ?
        'Use quoted remote paths, for example "~/.npmrc=packages/npmrc" or "~/.netrc=github/netrc", for private packages and Git repositories. Other paths, including those starting with /, resolve relative to the command working directory. Files are refreshed on the next command and kept for future commands; unset files are removed when the next command starts. '
      : 'Environment bindings apply to subsequent commands. ') +
      'The workload fetches values using its delegated secret read permissions. Repeated bindings are merged; --unset removes one and --clear removes all. Removing a binding preserves delegated permissions.';
    static strict = false;
    static examples = [
      `<%= config.bin %> ${platform} set ${kind}-from-secret ${
        kind === 'file' ? "'~/.npmrc=packages/npmrc'" : 'NPM_TOKEN=my/secret'
      }`,
      `<%= config.bin %> ${platform} set ${kind}-from-secret --unset ${
        kind === 'file' ? "'~/.npmrc'" : 'NPM_TOKEN'
      }`,
    ];
    static flags = {
      ...BaseCommand.baseFlags,
      id: Flags.string({ description: 'Instance ID. Defaults to the current target.' }),
      unset: Flags.string({
        description: 'Remove a saved binding by variable name or quoted remote file path.',
        multiple: true,
        multipleNonGreedy: true,
      }),
      clear: Flags.boolean({ description: 'Remove all saved bindings before applying new ones.' }),
    };
    async run(): Promise<void> {
      const { argv, flags } = await this.parse(SetSecretEnv);
      this.setParsedFlags(flags);
      const additions = parse(argv as string[]) ?? {};
      const remove = (flags.unset ?? []).map((key) =>
        kind === 'file' ? Object.keys(parseSecretFiles([key + '=validation'])!)[0]! : key,
      );
      if (!Object.keys(additions).length && !remove.length && !flags.clear)
        this.error('Provide NAME=secret/name, --unset NAME, or --clear.');
      for (const key of remove)
        if (kind === 'env' && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key))
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
          const bindings: Record<string, string> = {
            ...(flags.clear ? {}
            : kind === 'file' ?
              parseSecretFiles(
                Object.entries(instance.spec.fileFromSecret ?? {}).map(([key, target]) => `${key}=${target}`),
              )
            : instance.spec.envFromSecret),
            ...additions,
          };
          for (const key of remove) delete bindings[key];
          if (Object.keys(bindings).length > 64) this.error('At most 64 secret bindings are supported.');
          const required = secretReadPermissions(additions).filter(
            (permission) => !role.permissions.some((granted) => permissionCovers(granted, permission)),
          );
          try {
            await instances.update(target.id, {
              ifMatch: etag,
              spec: {
                [field]: bindings,
                ...(required.length && {
                  role: { permissions: [...new Set([...role.permissions, ...required])] },
                }),
              },
            });
            this.outputResult(
              { instanceId: target.id, [field]: bindings },
              `Updated secret ${kind} bindings on ${target.id}.`,
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
