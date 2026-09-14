import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { resolveRequestedXcodeVersion } from '../../lib/xcode-version';
import { syncFlags, syncOptionsFromFlags } from '../../lib/sync-flags';

export default class XcodeTools extends BaseCommand {
  static summary = 'Show the selected developer tools in an Xcode sandbox';
  static flags = {
    ...BaseCommand.baseFlags,
    ...syncFlags,
    id: Flags.string({ description: 'Xcode instance ID. Defaults to the most recent Xcode target.' }),
    cwd: Flags.string({ description: 'Project directory relative to the sync root.', default: '.' }),
    'no-sync': Flags.boolean({
      description: 'Inspect the current remote workspace without syncing.',
      default: false,
    }),
  };
  async run(): Promise<void> {
    const { flags } = await this.parse(XcodeTools);
    this.setParsedFlags(flags);
    await this.withAuth(async () => {
      const target = await this.resolveXcodeTargetOrCreate(flags.id);
      const client = await this.resolveXcodeClientForWork(target, resolveRequestedXcodeVersion(undefined));
      if (!flags['no-sync']) await client.sync(process.cwd(), syncOptionsFromFlags(flags));
      const proc = client.run(
        'test -n "$MISE_SYSTEM_INSTALLS_DIR" || { echo "This sandbox needs a newer Limrun toolchain image." >&2; exit 1; }; mise ls --current',
        { cwd: flags.cwd },
      );
      proc.stdout.on('data', (line: string) => process.stdout.write(line + '\n'));
      proc.stderr.on('data', (line: string) => process.stderr.write(line + '\n'));
      const result = await proc;
      if (result.exitCode !== 0)
        this.error(`Tool inspection failed with exit code ${result.exitCode}.`, { exit: result.exitCode });
    });
  }
}
