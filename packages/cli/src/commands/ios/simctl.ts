import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { detectInstanceType, getInstanceClient } from '../../lib/instance-client-factory';

type SimctlResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export default class IosSimctl extends BaseCommand {
  static summary = 'Run simctl on a running iOS instance';
  static description =
    'Run `simctl` against the target iOS instance with streaming stdout/stderr. Pass the command arguments after the subcommand, for example `lim ios simctl -- listapps booted`.';
  static examples = [
    '<%= config.bin %> ios simctl -- listapps booted',
    '<%= config.bin %> ios simctl -- getenv booted HOME',
    '<%= config.bin %> ios simctl -- listapps booted --json',
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
    const parsed = await this.parse(IosSimctl as any);
    const flags = parsed.flags as Record<string, any>;
    const rawArgs = (parsed.argv as string[]) ?? [];
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      if (rawArgs.length === 0) {
        this.error('Provide at least one simctl argument after `lim ios simctl --`.');
      }

      const id = this.resolveId(flags.id);
      if (detectInstanceType(id) !== 'ios') {
        this.error('ios simctl only supports iOS instances');
      }

      const { type, client, disconnect } = await getInstanceClient(this.client, id);
      if (type !== 'ios') {
        disconnect();
        this.error('ios simctl only supports iOS instances');
      }

      try {
        const execution = (client as any).simctl(rawArgs);

        if (flags.json) {
          const result = (await execution.wait()) as SimctlResult;
          this.outputJson(result);
          if (result.code !== 0) this.exit(result.code);
          return;
        }

        execution.on('stdout', (chunk: Buffer) => {
          process.stdout.write(chunk);
        });
        execution.on('stderr', (chunk: Buffer) => {
          process.stderr.write(chunk);
        });

        const result = (await new Promise<SimctlResult>((resolve, reject) => {
          execution.once('exit', (code: number) => {
            execution
              .wait()
              .then((waitResult: SimctlResult) => resolve({ ...waitResult, code }))
              .catch(reject);
          });
          execution.once('error', reject);
        })) as SimctlResult;

        if (result.code !== 0) {
          this.error(`simctl failed with exit code ${result.code}`, { exit: result.code });
        }
      } finally {
        disconnect();
      }
    });
  }
}
