import { Flags } from '@oclif/core';
import { BaseCommand } from '../base-command';
import { syncFlags, syncOptionsFromFlags } from './sync-flags';
import { syncBuildProject, streamBuildCommand } from './build-command-helpers';

export function buildToolsCommand(
  platform: 'xcode' | 'gradle',
  action: 'list' | 'install' = 'list',
): typeof BaseCommand {
  const install = action === 'install';
  return class BuildTools extends BaseCommand {
    static summary =
      install ?
        `Install selected tools in a ${platform} sandbox`
      : `Show the selected developer tools in a ${platform} sandbox`;
    static description =
      install ?
        'Sync the project and run mise install in an existing sandbox. Use --no-sync to install the current sandbox selections without uploading local changes.'
      : 'Inspect an existing sandbox without syncing or creating an instance. Use --sync to upload local project changes first. The first operation with project mise configuration also initializes its tools.';
    static examples =
      install ?
        [
          `<%= config.bin %> ${platform} tools install`,
          `<%= config.bin %> ${platform} tools install --cwd apps/mobile --no-sync`,
        ]
      : [`<%= config.bin %> ${platform} tools`, `<%= config.bin %> ${platform} tools --sync`];
    static flags = {
      ...BaseCommand.baseFlags,
      create: { ...BaseCommand.baseFlags.create, hidden: true, default: false },
      ...syncFlags,
      id: Flags.string({
        description: `${platform} instance ID. Defaults to the most recent ${platform} target.`,
      }),
      cwd: Flags.string({ description: 'Project directory relative to the sync root.', default: '.' }),
      sync: Flags.boolean({
        description: 'Sync the local project before resolving its tools.',
        default: install,
        allowNo: install,
      }),
    };
    async run(): Promise<void> {
      const { flags } = await this.parse(BuildTools);
      this.setParsedFlags(flags);
      await this.withAuth(async () => {
        const { client } = await this.resolveBuildToolClient(platform, flags.id, 'existing');
        if (flags.sync)
          await syncBuildProject(client, syncOptionsFromFlags(flags), (message) => this.info(message));
        await streamBuildCommand(
          client.run(install ? 'mise install' : 'mise ls --current', { cwd: flags.cwd }),
          (message, options) => this.error(message, options),
          install ? 'Tool installation failed' : 'Tool inspection failed',
        );
      });
    }
  };
}
