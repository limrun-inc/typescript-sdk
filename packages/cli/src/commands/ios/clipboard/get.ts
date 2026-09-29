import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { runIosSimctl } from '../../../lib/instance-client-factory';

export default class IosClipboardGet extends BaseCommand {
  static summary = 'Print the clipboard of a running iOS instance';
  static description =
    'Print the pasteboard text of a running iOS instance to standard output, without a trailing newline. Prints nothing when the pasteboard holds no text. Same as `lim ios simctl -- pbpaste booted`.';
  static examples = [
    '<%= config.bin %> ios clipboard get',
    '<%= config.bin %> ios clipboard get --id <instance-ID>',
    '<%= config.bin %> ios clipboard get --json',
  ];

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosClipboardGet);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const result = await runIosSimctl(this.client, this.resolveIosInstance(flags.id), [
        'pbpaste',
        'booted',
      ]);
      if (result.code !== 0) {
        this.error(result.stderr.trim() || `pbpaste failed with exit code ${result.code}`, {
          exit: result.code,
        });
      }
      const text = result.stdout;

      if (flags.json) {
        this.outputJson({ text });
      } else {
        process.stdout.write(text);
      }
    });
  }
}
