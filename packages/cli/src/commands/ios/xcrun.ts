import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { detectInstanceType, getInstanceClient } from '../../lib/instance-client-factory';

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export default class IosXcrun extends BaseCommand {
  static summary = 'Run xcrun on a running iOS instance';
  static description =
    'Run the limited `xcrun` surface exposed by the iOS SDK client. Pass the command arguments after the subcommand, for example `lim ios xcrun -- --show-sdk-version`.';
  static examples = [
    '<%= config.bin %> ios xcrun -- --show-sdk-version',
    '<%= config.bin %> ios xcrun -- --sdk iphonesimulator --show-sdk-version',
    '<%= config.bin %> ios xcrun -- --show-sdk-build-version --json',
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
    const parsed = await this.parse(IosXcrun as any);
    const flags = parsed.flags as Record<string, any>;
    const rawArgs = (parsed.argv as string[]) ?? [];
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      if (rawArgs.length === 0) {
        this.error('Provide at least one xcrun argument after `lim ios xcrun --`.');
      }

      const id = this.resolveId(flags.id);
      if (detectInstanceType(id) !== 'ios') {
        this.error('ios xcrun only supports iOS instances');
      }

      const { type, client, disconnect } = await getInstanceClient(this.client, id);
      try {
        if (type !== 'ios') {
          this.error('ios xcrun only supports iOS instances');
        }

        const result = (await (client as any).xcrun(rawArgs)) as CommandResult;
        if (flags.json) {
          this.outputJson(result);
          if (result.exitCode !== 0) this.exit(result.exitCode);
          return;
        }

        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        if (result.exitCode !== 0) {
          this.error(`xcrun failed with exit code ${result.exitCode}`, { exit: result.exitCode });
        }
      } finally {
        disconnect();
      }
    });
  }
}
