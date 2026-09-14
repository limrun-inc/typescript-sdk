import path from 'path';
import { Args, Flags } from '@oclif/core';
import { parseToolRequests, writeMiseTools } from '@limrun/api/mise-tools';
import { BaseCommand } from '../base-command';
import { syncFlags, syncOptionsFromFlags } from './sync-flags';
import { syncBuildProject, streamBuildCommand } from './build-command-helpers';

export function buildUseCommand(platform: 'xcode' | 'gradle'): typeof BaseCommand {
  return class BuildUse extends BaseCommand {
    static summary = `Select developer tool versions for a ${platform} sandbox`;
    static description = `Save compatibility lines in the client mise configuration and sync them to the sandbox. Run lim ${platform} run -- mise install to install missing versions. Ruby, Python, Go, Flutter, Dart and pre-1.0 tools retain major.minor; other tools retain the major.`;
    static strict = false;
    static args = {
      tools: Args.string({ required: true, description: 'One or more tool@version requests' }),
    };
    static examples = [
      `<%= config.bin %> ${platform} use node@24 pnpm@10 ruby@3.3`,
      `<%= config.bin %> ${platform} use --global node@24`,
      `<%= config.bin %> ${platform} use --cwd apps/mobile yarn@4`,
    ];
    static flags = {
      ...BaseCommand.baseFlags,
      ...syncFlags,
      id: Flags.string({
        description: `${platform} instance ID. Defaults to the most recent ${platform} target.`,
      }),
      cwd: Flags.string({ description: 'Project directory relative to the sync root.', default: '.' }),
      global: Flags.boolean({
        description: 'Save personal defaults in the client global mise configuration.',
        default: false,
      }),
    };

    async run(): Promise<void> {
      const { flags, argv } = await this.parse(BuildUse);
      this.setParsedFlags(flags);
      const tools = parseToolRequests(argv as string[]);
      const directory = path.resolve(process.cwd(), flags.cwd);
      const relative = path.relative(process.cwd(), directory);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        this.error('--cwd must stay inside the synced directory.');
      const file = await writeMiseTools(directory, tools, flags.global);
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
            ...(!flags.global && {
              include: (p: string) =>
                p === fileRelative ||
                fileRelative.startsWith(p.endsWith('/') ? p : `${p}/`) ||
                (sync?.include?.(p) ?? false),
            }),
          },
          (message) => this.info(message),
        );
        // Remove explicit sandbox overrides for these tools before resolving the new client requests.
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
          'Tool selection failed after saving the client configuration',
        );
        this.info(`Run lim ${platform} run -- mise install if a selected version is missing.`);
      });
    }
  };
}
