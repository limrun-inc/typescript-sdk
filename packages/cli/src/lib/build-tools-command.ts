import { Flags } from '@oclif/core';
import { BaseCommand } from '../base-command';
import { syncFlags, syncOptionsFromFlags } from './sync-flags';
import { syncBuildProject, streamBuildCommand } from './build-command-helpers';

export function buildToolsCommand(platform: 'xcode' | 'gradle'): typeof BaseCommand {
  return class BuildTools extends BaseCommand {
    static summary = `Show the selected developer tools in a ${platform} sandbox`;
    static description =
      'Inspect an existing sandbox without syncing or creating an instance. Use --sync to upload local project changes first.';
    static flags = {
      ...BaseCommand.baseFlags,
      create: { ...BaseCommand.baseFlags.create, hidden: true, default: false },
      ...syncFlags,
      id: Flags.string({
        description: `${platform} instance ID. Defaults to the most recent ${platform} target.`,
      }),
      cwd: Flags.string({ description: 'Project directory relative to the sync root.', default: '.' }),
      sync: Flags.boolean({
        description: 'Sync the local project before inspecting its tools.',
        default: false,
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
          client.run('mise ls --current', { cwd: flags.cwd }),
          (message, options) => this.error(message, options),
          'Tool inspection failed',
        );
      });
    }
  };
}
