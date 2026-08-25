import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { syncFlags } from '../../lib/sync-flags';
import { compileIgnorePatterns } from '../../lib/ignore-patterns';
import { formatDurationMs } from '../../lib/duration';
import { formatBytes } from '../../lib/bytes';
import { parseAdditionalFileFlags } from '../../lib/additional-files';
import { parseEnvEntries } from '../../lib/env-entries';

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
    ...syncFlags,
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

    const env = parseEnvEntries(flags.env ?? [], (message) => this.error(message));
    const commandLine =
      commandArgs.length === 1 ? commandArgs[0] : commandArgs.map(quoteShellArgument).join(' ');

    await this.withAuth(async () => {
      const target = await this.resolveXcodeTargetOrCreate(flags.id);
      const xcodeClient = await this.resolveXcodeClient(target);

      // The build sandbox hosts no simulators, so simctl install/boot/launch
      // is denied there. Steer to the attach flow before the command runs.
      if (/\bsimctl\b/.test(commandLine)) {
        this.info(
          'Note: the Xcode sandbox does not host simulators, so simctl cannot install or launch apps here. ' +
            'Create a cloud iOS simulator attached to this instance instead; it gets the latest build installed ' +
            'right away and every next build installed and reloaded automatically:\n' +
            `  lim ios create --attach ${target.id}`,
        );
      }

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
          // 'timeout' means the stream was alive and the work outlived the
          // budget; a lost or closed stream means the execution may be gone.
          this.error(
            result.incomplete && result.incomplete.reason !== 'timeout' ?
              `${result.incomplete.message}.`
            : 'Timed out waiting for the command to finish; the remote command may still be running.',
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
