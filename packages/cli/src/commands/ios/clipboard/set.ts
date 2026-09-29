import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { getIosInstanceClient } from '../../../lib/instance-client-factory';
import { readStdin } from '../../../lib/stdin';

export default class IosClipboardSet extends BaseCommand {
  static summary = 'Set the clipboard of a running iOS instance';
  static description =
    'Replace the pasteboard of a running iOS instance with the given text, or with standard input when no text is given. Apps then paste it like text copied inside the simulator. Same as `lim ios simctl -- pbcopy booted`.';
  static examples = [
    '<%= config.bin %> ios clipboard set "hello world"',
    'echo "one-time code 123456" | <%= config.bin %> ios clipboard set',
    '<%= config.bin %> ios clipboard set "hello" --id <instance-ID>',
  ];

  static args = {
    text: Args.string({
      description: 'Text to put on the clipboard. Reads standard input when omitted.',
      required: false,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosClipboardSet);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      if (args.text === undefined && process.stdin.isTTY) {
        this.error('Provide the text as an argument or pipe it on stdin.');
      }
      const text = args.text ?? (await readStdin()).toString('utf8');
      const { client, disconnect } = await getIosInstanceClient(
        this.client,
        this.resolveIosInstance(flags.id),
      );
      try {
        const result = await client.simctl(['pbcopy', 'booted'], { stdin: text }).wait();
        if (result.code !== 0) this.error(result.stderr.trim(), { exit: result.code });
      } finally {
        disconnect();
      }

      if (flags.json) {
        this.outputJson({ updated: true });
      } else {
        this.log('Clipboard set');
      }
    });
  }
}
