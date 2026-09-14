import path from 'path';
import { Args, Flags } from '@oclif/core';
import { parseToolRequests, writeMiseTools } from '@limrun/api/mise-tools';
import { BaseCommand } from '../../base-command';
import { resolveRequestedXcodeVersion } from '../../lib/xcode-version';
import { syncFlags, syncOptionsFromFlags } from '../../lib/sync-flags';

export default class XcodeUse extends BaseCommand {
  static summary = 'Select developer tool versions for an Xcode sandbox';
  static description =
    'Save compatibility lines in the client mise configuration, sync, and prepare the selected tools remotely. Ruby, Python, Go, Flutter, Dart and pre-1.0 tools retain major.minor; other tools retain the major.';
  static strict = false;
  static args = { tools: Args.string({ required: true, description: 'One or more tool@version requests' }) };
  static examples = [
    '<%= config.bin %> xcode use node@24 pnpm@10 ruby@3.3',
    '<%= config.bin %> xcode use --global node@24',
    '<%= config.bin %> xcode use --cwd apps/mobile yarn@4',
  ];
  static flags = {
    ...BaseCommand.baseFlags,
    ...syncFlags,
    id: Flags.string({ description: 'Xcode instance ID. Defaults to the most recent Xcode target.' }),
    cwd: Flags.string({ description: 'Project directory relative to the sync root.', default: '.' }),
    global: Flags.boolean({
      description: 'Save personal defaults in the client global mise configuration.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags, argv } = await this.parse(XcodeUse);
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
      const target = await this.resolveXcodeTargetOrCreate(flags.id);
      const client = await this.resolveXcodeClientForWork(target, resolveRequestedXcodeVersion(undefined));
      const sync = syncOptionsFromFlags(flags);
      const fileRelative = path.relative(process.cwd(), file).split(path.sep).join('/');
      await client.sync(process.cwd(), {
        ...sync,
        ...(!flags.global && {
          include: (p: string) =>
            p === fileRelative ||
            fileRelative.startsWith(p.endsWith('/') ? p : `${p}/`) ||
            (sync?.include?.(p) ?? false),
        }),
      });
      // Remove explicit sandbox overrides for these tools before resolving the new client requests.
      const remove = Object.keys(tools)
        .map((name) => `--remove '${name}'`)
        .join(' ');
      for (const command of [
        `test -n "$MISE_SYSTEM_INSTALLS_DIR" || { echo "This sandbox needs a newer Limrun toolchain image." >&2; exit 1; }; mise use --path .limrun-runtime-mise.toml ${remove}`,
        'mise ls --current',
      ]) {
        const proc = client.run(command, { cwd: flags.cwd });
        proc.stdout.on('data', (line: string) => process.stdout.write(line + '\n'));
        proc.stderr.on('data', (line: string) => process.stderr.write(line + '\n'));
        const result = await proc;
        if (result.exitCode !== 0)
          this.error(
            `Tool selection failed with exit code ${result.exitCode}. The client configuration was saved; retry after correcting the error.`,
            { exit: result.exitCode },
          );
      }
    });
  }
}
