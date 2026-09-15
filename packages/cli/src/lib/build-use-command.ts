import { Args, Flags } from '@oclif/core';
import { parseToolRequests } from '@limrun/api/mise-tools';
import { BaseCommand } from '../base-command';
import { parseXcodeMajor } from './xcode-version';
import { streamBuildCommand } from './build-command-helpers';

export function buildUseCommand(platform: 'xcode' | 'gradle'): typeof BaseCommand {
  return class BuildUse extends BaseCommand {
    static summary = `Select developer tool versions for a ${platform} sandbox`;
    static description =
      (platform === 'xcode' ?
        'xcode@<major> selects Xcode for the workspace, like lim xcode version set. '
      : '') +
      `Select tool versions in an existing sandbox after syncing your project. Mise installs a requested version if needed. Use lim ${platform} tools install for synced project tool selections.`;
    static strict = false;
    static args = {
      tools: Args.string({ required: true, description: 'One or more tool@version requests' }),
    };
    static examples = [
      ...(platform === 'xcode' ? ['<%= config.bin %> xcode use xcode@27'] : []),
      `<%= config.bin %> ${platform} use node@24 pnpm@10`,
      `<%= config.bin %> ${platform} use --cwd apps/mobile yarn@4`,
    ];
    static flags = {
      ...BaseCommand.baseFlags,
      id: Flags.string({
        description: `${platform} instance ID. Defaults to the most recent ${platform} target.`,
      }),
      cwd: Flags.string({ description: 'Project directory relative to the sync root.', default: '.' }),
    };

    async run(): Promise<void> {
      const { flags, argv } = await this.parse(BuildUse);
      this.setParsedFlags(flags);
      let xcodeMajor: string | undefined;
      const requests: string[] = [];
      for (const request of argv as string[]) {
        if (request.startsWith('xcode@')) {
          if (platform !== 'xcode') this.error('Select Xcode with lim xcode use xcode@<major>.');
          xcodeMajor = parseXcodeMajor(request.slice('xcode@'.length), 'xcode use xcode@<major>');
        } else {
          requests.push(request);
        }
      }
      parseToolRequests(requests);
      if (xcodeMajor) await this.setPreferredXcodeVersion(xcodeMajor, flags.id);
      if (!requests.length) return;
      await this.withAuth(async () => {
        const { client } = await this.resolveBuildToolClient(platform, flags.id, 'existing');
        const quoted = requests.map((request) => `'${request.split("'").join("'\"'\"'")}'`).join(' ');
        const command = `mise --quiet use ${quoted}`;
        const proc = client.run(command, { cwd: flags.cwd });
        await streamBuildCommand(
          proc,
          (message, options) => this.error(message, options),
          'Tool selection failed',
        );
        this.info(`Selected ${requests.join(', ')} in the ${platform} sandbox.`);
      });
    }
  };
}
