import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { streamBuildCommand } from '../../lib/build-command-helpers';
import { parseEnvEntries } from '../../lib/env-entries';

export default class MacosRun extends BaseCommand {
  static summary = 'Run a shell command inside a macOS instance';
  static description =
    'Run a command line inside the macOS guest as its user, limrun, in its login session and with a login shell. Output streams as it arrives and the command exit code becomes this command exit code. Ctrl-C ends the remote command. The user can run sudo without a password.';
  static examples = [
    '<%= config.bin %> macos run -- sw_vers',
    '<%= config.bin %> macos run --cwd Desktop -- ls -la',
    "<%= config.bin %> macos run --env NAME=value -- 'echo $NAME'",
    '<%= config.bin %> macos run -- open -a TextEdit',
    '<%= config.bin %> macos exec -- uname -a',
  ];
  static aliases = ['macos:exec'];
  static strict = false;

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'macOS instance ID. Defaults to the last created macOS instance.' }),
    cwd: Flags.string({
      description:
        'Working directory, relative to the home directory or absolute. Default: home. Avoid Desktop, Documents and Downloads: macOS asks for permission to use them, and the command waits on that prompt.',
    }),
    env: Flags.string({ description: 'Environment variable in KEY=VALUE form, repeatable.', multiple: true }),
    timeout: Flags.integer({
      description: 'Seconds before the remote command is stopped (1-21600). Default: 3600.',
      min: 1,
      max: 21600,
    }),
  };

  async run(): Promise<void> {
    const delimiter = this.argv.indexOf('--');
    if (delimiter < 0) {
      this.error('Separate the remote command with --, for example: lim macos run -- sw_vers');
    }
    const commandArgs = this.argv.slice(delimiter + 1);
    if (commandArgs.length === 0) {
      this.error('A command is required after `--`.');
    }
    const { flags } = await this.parse(MacosRun, this.argv.slice(0, delimiter));
    this.setParsedFlags(flags);
    const env = parseEnvEntries(flags.env ?? [], (message) => this.error(message));
    const commandLine =
      commandArgs.length === 1 ? commandArgs[0]! : commandArgs.map(quoteShellArgument).join(' ');

    await this.withAuth(async () => {
      const { client } = await this.resolveMacosClient(flags.id);
      const proc = client.run(commandLine, {
        ...(flags.cwd && { cwd: flags.cwd }),
        ...(env && { env }),
        ...(flags.timeout !== undefined && { timeoutSeconds: flags.timeout }),
      });
      // Ctrl-C or a SIGTERM ends the remote command too; the stream then reports its exit.
      const interrupt = () => void proc.kill();
      process.once('SIGINT', interrupt);
      process.once('SIGTERM', interrupt);
      try {
        await streamBuildCommand(
          proc,
          (message, options) => this.error(message, options),
          'Command failed',
          this.isJsonEnabled() ? (result) => this.outputJson(result) : undefined,
        );
      } finally {
        process.off('SIGINT', interrupt);
        process.off('SIGTERM', interrupt);
      }
    });
  }
}

function quoteShellArgument(value: string): string {
  return `'${value.split("'").join("'\"'\"'")}'`;
}
