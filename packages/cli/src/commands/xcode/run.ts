import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { compileIgnorePatterns } from '../../lib/ignore-patterns';
import { formatDurationMs } from '../../lib/duration';
import { formatBytes } from '../../lib/bytes';
import { parseAdditionalFileFlags } from '../../lib/additional-files';

export default class XcodeRun extends BaseCommand {
  static summary = 'Run a command on an Xcode sandbox';
  static description =
    'Sync the current directory, then run a one-shot shell command in the remote workspace with streamed output.';

  static examples = [
    '<%= config.bin %> xcode run -- make api',
    '<%= config.bin %> xcode run apps/api -- make generate',
    '<%= config.bin %> xcode run --env API_ENV=development -- npm run generate',
    '<%= config.bin %> xcode run --no-sync -- mise run build',
  ];

  static args = {
    cwd: Args.string({
      description: 'Remote working directory relative to the synced workspace root. Defaults to ".".',
      required: false,
      default: '.',
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Xcode instance ID to run on. Defaults to the most recent standalone Xcode target.',
    }),
    env: Flags.string({
      description: 'Environment variable in KEY=VALUE form. Repeat for multiple variables.',
      multiple: true,
      multipleNonGreedy: true,
    }),
    timeout: Flags.integer({
      description: 'Server-side command timeout in seconds. Defaults to 3600, max 21600.',
      min: 1,
      max: 21600,
    }),
    'no-sync': Flags.boolean({
      description: 'Skip syncing the current directory before running the command.',
      default: false,
    }),
    'basis-cache-dir': Flags.string({
      description: 'Directory to use for the client-side delta sync cache.',
    }),
    ignore: Flags.string({
      description: 'Regular expression to ignore matching relative paths during sync. Repeat for multiple.',
      multiple: true,
      multipleNonGreedy: true,
    }),
    include: Flags.string({
      description:
        'Regular expression to force-sync matching relative paths even when gitignored. Repeat for multiple.',
      multiple: true,
      multipleNonGreedy: true,
    }),
    'additional-file': Flags.string({
      description:
        'Additional file to sync as localPath=remotePath, for example ~/.netrc=~/.netrc. Repeat for multiple.',
      multiple: true,
      multipleNonGreedy: true,
    }),
  };

  async run(): Promise<void> {
    const delimiter = this.argv.indexOf('--');
    if (delimiter < 0) {
      this.error('Separate the remote command with `--`, for example: lim xcode run -- make api');
    }
    const commandArgs = this.argv.slice(delimiter + 1);
    if (commandArgs.length === 0) {
      this.error('A command is required after `--`.');
    }
    const { args, flags } = await this.parse(XcodeRun, this.argv.slice(0, delimiter));
    this.setParsedFlags(flags);

    const env = parseEnvironmentEntries(flags.env ?? [], (message) => this.error(message));
    const commandLine =
      commandArgs.length === 1 ? commandArgs[0] : commandArgs.map(quoteShellArgument).join(' ');

    await this.withAuth(async () => {
      const target = await this.resolveXcodeTargetOrCreate(flags.id);
      const xcodeClient = await this.resolveXcodeClient(target);

      if (!flags['no-sync']) {
        const syncPath = process.cwd();
        this.info(`Syncing ${syncPath} to instance ${target.id}...`);
        const syncStart = Date.now();
        const result = await xcodeClient.sync(syncPath, {
          watch: false,
          install: false,
          basisCacheDir: flags['basis-cache-dir'],
          ignore: compileIgnorePatterns(flags.ignore),
          include: compileIgnorePatterns(flags.include),
          additionalFiles: parseAdditionalFileFlags(flags['additional-file']),
        });
        const syncDuration = formatDurationMs(Date.now() - syncStart);
        const syncedSize = result.bytesSent !== undefined ? ` (${formatBytes(result.bytesSent)} sent)` : '';
        this.info(`Sync completed in ${syncDuration}${syncedSize}.`);
      }

      this.info(`Running in ${args.cwd ?? '.'}: ${commandLine}`);
      const proc = xcodeClient.run(commandLine, {
        cwd: args.cwd ?? '.',
        ...(env && { env }),
        ...(flags.timeout !== undefined && { timeoutSeconds: flags.timeout }),
      });
      proc.stdout.on('data', (line: string) => process.stdout.write(line + '\n'));
      proc.stderr.on('data', (line: string) => process.stderr.write(line + '\n'));
      const result = await proc;
      if (result.exitCode !== 0) {
        if (result.timedOut) {
          this.error(
            'Timed out waiting for the command to finish; the remote command may still be running.',
            { exit: result.exitCode },
          );
        }
        this.error(`Command failed with exit code ${result.exitCode}`, { exit: result.exitCode });
      }
    });
  }
}

function quoteShellArgument(value: string): string {
  return `'${value.split("'").join("'\"'\"'")}'`;
}

function parseEnvironmentEntries(
  entries: string[],
  fail: (message: string) => never,
): Record<string, string> | undefined {
  if (entries.length === 0) return undefined;
  const env: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator <= 0) {
      fail(`Invalid --env value ${JSON.stringify(entry)}; expected KEY=VALUE.`);
    }
    const key = entry.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      fail(`Invalid environment variable name ${JSON.stringify(key)}.`);
    }
    env[key] = entry.slice(separator + 1);
  }
  return env;
}
