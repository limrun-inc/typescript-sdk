import path from 'path';
import { Args, Flags } from '@oclif/core';
import { parseToolRequests, writeMiseTools } from '@limrun/api/mise-tools';
import { BaseCommand } from '../base-command';
import { parseXcodeMajor } from './xcode-version';
import { syncFlags, syncOptionsFromFlags } from './sync-flags';
import { syncBuildProject, streamBuildCommand } from './build-command-helpers';

export function buildUseCommand(platform: 'xcode' | 'gradle'): typeof BaseCommand {
  return class BuildUse extends BaseCommand {
    static summary = `Select developer tool versions for a ${platform} sandbox`;
    static description =
      (platform === 'xcode' ?
        'xcode@<major> selects Xcode for the workspace, like lim xcode version set. '
      : '') +
      `Save compatibility lines in the project mise configuration and sync them to the sandbox. The first sandbox operation with project mise configuration initializes its tools. Run lim ${platform} tools install after later changes. Ruby, Python, Go, Flutter, Dart and pre-1.0 tools retain major.minor; other tools retain the major.`;
    static strict = false;
    static args = {
      tools: Args.string({ required: true, description: 'One or more tool@version requests' }),
    };
    static examples = [
      ...(platform === 'xcode' ? ['<%= config.bin %> xcode use xcode@27'] : []),
      `<%= config.bin %> ${platform} use node@24 pnpm@10 ruby@3.3`,
      `<%= config.bin %> ${platform} use --cwd apps/mobile yarn@4`,
    ];
    static flags = {
      ...BaseCommand.baseFlags,
      ...syncFlags,
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
        if (platform === 'xcode' && request.startsWith('xcode@')) {
          xcodeMajor = parseXcodeMajor(request.slice('xcode@'.length), 'xcode use xcode@<major>');
        } else {
          requests.push(request);
        }
      }
      const tools = requests.length ? parseToolRequests(requests) : {};
      const directory = path.resolve(process.cwd(), flags.cwd);
      const relative = path.relative(process.cwd(), directory);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        this.error('--cwd must stay inside the synced directory.');
      if (xcodeMajor) await this.setPreferredXcodeVersion(xcodeMajor, flags.id);
      if (!requests.length) return;
      const file = await writeMiseTools(directory, tools);
      this.info(
        `Saved ${Object.entries(tools)
          .map(([name, version]) => `${name}@${version}`)
          .join(', ')} in ${file}.`,
      );
      await this.withAuth(async () => {
        const { client } = await this.resolveBuildToolClient(platform, flags.id);
        const sync = syncOptionsFromFlags(flags);
        const fileRelative = path.relative(process.cwd(), file).split(path.sep).join('/');
        await syncBuildProject(
          client,
          {
            ...sync,
            include: (p: string) =>
              p === fileRelative ||
              fileRelative.startsWith(p.endsWith('/') ? p : `${p}/`) ||
              (sync?.include?.(p) ?? false),
          },
          (message) => this.info(message),
        );
        // Remove explicit sandbox overrides for these tools before resolving the new project requests.
        const remove = Object.keys(tools)
          .map((name) => `'${name}'`)
          .join(' ');
        const command = [
          `if test -f .limrun-runtime-mise.toml; then mise unuse --no-prune --path .limrun-runtime-mise.toml ${remove}; fi`,
          'mise ls --current',
        ].join(' && ');
        const proc = client.run(command, { cwd: flags.cwd });
        await streamBuildCommand(
          proc,
          (message, options) => this.error(message, options),
          'Tool selection failed after saving the project configuration',
        );
        this.info(`Run lim ${platform} tools install if a selected version is missing.`);
      });
    }
  };
}
