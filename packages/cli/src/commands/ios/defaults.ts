import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { runIosSimctl } from '../../lib/instance-client-factory';

export default class IosDefaults extends BaseCommand {
  static summary = 'Read or write user defaults on a running iOS instance';
  static description =
    "Run the simulator's `defaults read`, `write` or `delete`, for example to change the device language without UI automation. Pass the arguments after `--`. Apps launched afterwards see the change. Same as `lim ios simctl -- spawn booted defaults ...`.";
  static examples = [
    '<%= config.bin %> ios defaults -- write -g AppleLanguages -array fr-FR',
    '<%= config.bin %> ios defaults -- write -g AppleLocale -string fr_FR',
    '<%= config.bin %> ios defaults -- read -g AppleLanguages',
    '<%= config.bin %> ios defaults --id <instance-ID> -- delete com.example.app someKey',
  ];

  static strict = false;

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const parsed = await this.parse(IosDefaults as any);
    const flags = parsed.flags as Record<string, any>;
    const rawArgs = (parsed.argv as string[]) ?? [];
    this.setParsedFlags(flags);

    // limulator decides which defaults verbs run; the CLI only needs something to send.
    if (rawArgs.length === 0) {
      this.error('Usage: lim ios defaults -- read|write|delete <domain> [key] [value...]');
    }

    await this.withAuth(async () => {
      const result = await runIosSimctl(this.client, this.resolveIosInstance(flags.id), [
        'spawn',
        'booted',
        'defaults',
        ...rawArgs,
      ]);
      if (flags.json) {
        this.outputJson(result);
      } else {
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
      }
      if (result.code !== 0) this.exit(result.code);
    });
  }
}
