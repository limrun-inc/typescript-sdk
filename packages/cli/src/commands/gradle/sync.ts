import { Args, Flags } from '@oclif/core';
import type { GradleSyncOptions } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import { syncFlags } from '../../lib/sync-flags';
import { compileIgnorePatterns } from '../../lib/ignore-patterns';
import { formatDurationMs } from '../../lib/duration';
import { formatBytes } from '../../lib/bytes';
import { parseAdditionalFileFlags } from '../../lib/additional-files';

export default class GradleSync extends BaseCommand {
  static summary = 'Sync local source code to a Gradle sandbox';
  static description =
    'Push local source code and project files to a remote Gradle sandbox, using the current working directory when no path is given. Add --watch to keep syncing changes. This command does not run Gradle or install dependencies. For a build, use `gradle build`, which already syncs the project first.';

  static examples = [
    '<%= config.bin %> gradle sync',
    '<%= config.bin %> gradle sync ./MyProject --id <gradle-instance-ID>',
    '<%= config.bin %> gradle sync ./MyProject --watch',
    '<%= config.bin %> gradle sync ./MyProject --basis-cache-dir ./.limsync-cache',
    '<%= config.bin %> gradle sync ./MyProject --ignore "^artifacts/"',
    '<%= config.bin %> gradle sync ./MyProject --additional-file ~/.npmrc=.npmrc',
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
        'Gradle instance ID to sync to. Defaults to the last used instance, creating one if needed.',
    }),
    watch: Flags.boolean({
      description: 'Keep watching the local source tree and push changes automatically',
      default: false,
      allowNo: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(GradleSync);
    this.setParsedFlags(flags);

    const syncPath = args.path ?? process.cwd();
    const syncOptions: GradleSyncOptions = {
      watch: flags.watch,
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
    await this.withAuth(async () => {
      const target = await this.resolveGradleTargetOrCreate(flags.id);
      const gradleClient = await this.resolveGradleClient(target);
      this.info(`Syncing ${syncPath} to instance ${target.id}...`);
      const result = await gradleClient.sync(syncPath, syncOptions);

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
