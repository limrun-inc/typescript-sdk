import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { resolveRequestedXcodeVersion } from '../../lib/xcode-version';
import { syncFlags } from '../../lib/sync-flags';
import { compileIgnorePatterns } from '../../lib/ignore-patterns';
import { formatDurationMs } from '../../lib/duration';
import { formatBytes } from '../../lib/bytes';
import { parseAdditionalFileFlags } from '../../lib/additional-files';

export default class XcodeSync extends BaseCommand {
  static summary = 'Continuously sync local source code to an Xcode sandbox';
  static description =
    'Push local source code and project files (or the current working directory if omitted) to a remote Xcode sandbox with optional watch mode. This command is mostly useful for continuous sync workflows with `--watch`; for most one-shot builds, use `xcode build`, which already syncs the project path first. This works with standalone Xcode instances and can also target a legacy iOS instance with an embedded Xcode sandbox when you pass `--id`.';

  static examples = [
    '<%= config.bin %> xcode sync --watch',
    '<%= config.bin %> xcode sync ./MyProject --id <ios-instance-ID> --no-install',
    '<%= config.bin %> xcode build ./MyProject --scheme MyApp',
    '<%= config.bin %> xcode sync ./MyProject --basis-cache-dir ./.limsync-cache',
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
    ...syncFlags,
    id: Flags.string({
      description:
        'Xcode instance ID to sync to, or a legacy iOS instance ID with an embedded Xcode sandbox. Defaults to the most recent standalone Xcode target, creating one if needed.',
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
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(XcodeSync);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const target = await this.resolveXcodeTargetOrCreate(flags.id);
      const id = target.id;
      const syncPath = args.path ?? process.cwd();
      const xcodeClient = await this.resolveXcodeClientForWork(
        target,
        resolveRequestedXcodeVersion(undefined),
      );

      this.info(`Syncing ${syncPath} to instance ${id}...`);

      const syncOptions = {
        watch: flags.watch,
        install: flags.install,
        basisCacheDir: flags['basis-cache-dir'],
        ignore: compileIgnorePatterns(flags.ignore),
        include: compileIgnorePatterns(flags.include),
        additionalFiles: parseAdditionalFileFlags(flags['additional-file']),
        onSyncComplete: (event: { bytesSent: number; durationMs: number }) => {
          this.output(
            `Sync completed in ${formatDurationMs(event.durationMs)} (${formatBytes(event.bytesSent)} sent).`,
          );
        },
      };
      const result = await xcodeClient.sync(syncPath, syncOptions as Parameters<typeof xcodeClient.sync>[1]);

      if (flags.watch && result.stopWatching) {
        this.output('Watching for changes. Press Ctrl+C to stop.');
        await new Promise<void>((resolve) => {
          const keepAlive = setInterval(() => {}, 1 << 30);
          let shuttingDown = false;
          const shutdown = () => {
            if (shuttingDown) return;
            shuttingDown = true;
            clearInterval(keepAlive);
            process.off('SIGINT', shutdown);
            process.off('SIGTERM', shutdown);
            void (async () => {
              try {
                await result.stopWatching!();
              } catch (err) {
                this.warn(
                  `Failed to stop source watcher cleanly: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
              } finally {
                resolve();
              }
            })();
          };
          process.on('SIGINT', shutdown);
          process.on('SIGTERM', shutdown);
        });
      }
    });
  }
}
