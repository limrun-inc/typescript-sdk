import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getAndroidInstanceClient } from '../../lib/instance-client-factory';

export default class AndroidAdbShell extends BaseCommand {
  static summary = 'Run a shell command on a running Android instance (like adb shell)';
  static description =
    'Run a command on the Android instance without needing adb installed locally. ' +
    'The command runs with the same permissions the adb shell user has, and its stdout, stderr, ' +
    'and exit code are returned. Pass the command and its arguments after `--`; each argument is ' +
    'sent as a separate, quoted token. To use shell features like pipes, invoke a shell explicitly ' +
    '(e.g. `-- sh -c "..."`). The CLI exits with the command\'s exit code.';

  // Everything after `--` is captured verbatim as the command and its args.
  static strict = false;

  static examples = [
    '<%= config.bin %> android adb-shell -- pm list packages -3',
    '<%= config.bin %> android adb-shell -- getprop ro.build.version.sdk',
    '<%= config.bin %> android adb-shell --id <instance-ID> -- sh -c "dumpsys battery | grep level"',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to target. Defaults to the last created Android instance.',
    }),
    timeout: Flags.integer({
      description: 'Command timeout in milliseconds.',
      default: 30000,
    }),
  };

  async run(): Promise<void> {
    const { argv, flags } = await this.parse(AndroidAdbShell);
    this.setParsedFlags(flags);

    const tokens = argv as string[];
    if (tokens.length === 0) {
      this.error('Provide a command after `--`, e.g. `android adb-shell -- pm list packages -3`.');
    }
    const [command, ...args] = tokens;

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveAndroidInstance(flags.id);
      const { client, disconnect } = await getAndroidInstanceClient(this.client, resolvedInstance);
      try {
        const result = await client.adbShell(command, args, { timeoutMs: flags.timeout });
        if (flags.json) {
          this.outputJson(result);
        } else {
          if (result.stdout) {
            process.stdout.write(result.stdout);
          }
          if (result.stderr) {
            process.stderr.write(result.stderr);
          }
          if (result.truncated) {
            process.stderr.write('\n[output truncated]\n');
          }
        }
        if (result.exitCode !== 0) {
          this.exit(result.exitCode);
        }
      } finally {
        disconnect();
      }
    });
  }
}
