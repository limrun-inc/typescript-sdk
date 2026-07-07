import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { compileIgnorePatterns } from '../../lib/ignore-patterns';
import { formatDurationMs } from '../../lib/duration';
import { parseAdditionalFileFlags } from '../../lib/additional-files';
import { ProgressReporter } from '../../lib/progress';
import { syncProgressRenderer } from '../../lib/sync-progress';

export default class XcodeSync extends BaseCommand {
  static summary = 'Continuously sync local source code to an Xcode sandbox';
  static description =
    'Push local source code and project files (or the current working directory if omitted) to a remote Xcode sandbox with optional watch mode. This command is mostly useful for continuous sync workflows with `--watch`; for most one-shot builds, use `xcode build`, which already syncs the project path first. This works with standalone Xcode instances and can also target an iOS instance with `--xcode` enabled or created via `xcode create --ios` when you pass `--id`.';

  static examples = [
    '<%= config.bin %> xcode sync --watch',
    '<%= config.bin %> xcode sync ./MyProject --id <ios-instance-ID> --no-install',
    '<%= config.bin %> xcode build ./MyProject --scheme MyApp',
    '<%= config.bin %> xcode sync ./MyProject --basis-cache-dir ./.limsync-cache --max-patch-bytes 2097152',
    '<%= config.bin %> xcode sync ./MyProject --ignore "\\\\.xcuserdata/" --ignore "^DerivedData/"',
    '<%= config.bin %> xcode sync ./MyProject --additional-file ~/.netrc=~/.netrc',
  ];

  static args = {
    path: Args.string({
      description: 'Local source code or project path to sync. Defaults to the current working directory.',
      required: false,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description:
        'Xcode instance ID to sync to, or an explicit iOS instance ID with `--xcode` enabled. Defaults to the most recent standalone Xcode target, creating one if needed.',
    }),
    watch: Flags.boolean({
      description: 'Keep watching the local source tree and push changes automatically',
      default: false,
      allowNo: true,
    }),
    install: Flags.boolean({
      description: 'Run install behavior after each sync when the sandbox supports it',
      default: true,
      allowNo: true,
    }),
    'basis-cache-dir': Flags.string({
      description: 'Directory to use for the client-side delta sync cache.',
    }),
    'max-patch-bytes': Flags.integer({
      description: 'Maximum patch size in bytes before falling back to a full upload.',
    }),
    ignore: Flags.string({
      description:
        'Regular expression to ignore matching relative paths during sync. Repeat for multiple patterns.',
      multiple: true,
    }),
    'additional-file': Flags.string({
      description:
        'Additional file to sync as localPath=remotePath, for example ~/.netrc=~/.netrc. Repeat for multiple files.',
      multiple: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(XcodeSync);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const target = await this.resolveXcodeTargetOrCreate(flags.id);
      const id = target.id;
      const syncPath = args.path ?? process.cwd();
      const xcodeClient = await this.resolveXcodeClient(target);

      const reporter = new ProgressReporter(() => this.shouldSuppressInfo());
      reporter.start(`Syncing ${syncPath} to instance ${id}...`);
      const syncStart = Date.now();

      const syncOptions = {
        watch: flags.watch,
        install: flags.install,
        basisCacheDir: flags['basis-cache-dir'],
        maxPatchBytes: flags['max-patch-bytes'],
        ignore: compileIgnorePatterns(flags.ignore),
        additionalFiles: parseAdditionalFileFlags(flags['additional-file']),
        onProgress: syncProgressRenderer(reporter, 'Syncing'),
      };
      let result: Awaited<ReturnType<typeof xcodeClient.sync>>;
      try {
        result = await xcodeClient.sync(syncPath, syncOptions as Parameters<typeof xcodeClient.sync>[1]);
      } catch (err) {
        reporter.stop('failure', 'Sync failed');
        throw err;
      }
      reporter.stop('success', `Sync complete in ${formatDurationMs(Date.now() - syncStart)}.`);

      if (flags.watch && result.stopWatching) {
        this.output('Watching for changes. Press Ctrl+C to stop.');
        await new Promise<void>((resolve) => {
          const keepAlive = setInterval(() => {}, 1 << 30);
          const shutdown = () => {
            clearInterval(keepAlive);
            result.stopWatching!();
            resolve();
          };
          process.on('SIGINT', shutdown);
          process.on('SIGTERM', shutdown);
        });
      }
    });
  }
}
