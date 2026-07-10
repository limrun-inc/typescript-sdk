import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getAndroidInstanceClient } from '../../lib/instance-client-factory';
import { formatDurationMs } from '../../lib/duration';
import { formatBytes } from '../../lib/bytes';

export default class AndroidSync extends BaseCommand {
  static summary = 'Sync an APK to a running Android instance';
  static description =
    'Delta-sync a local APK to a running Android instance using xdelta3 and optionally install or relaunch it after each sync.';

  static examples = [
    '<%= config.bin %> android sync ./app-debug.apk',
    '<%= config.bin %> android sync ./app-debug.apk --id <android-instance-ID>',
    '<%= config.bin %> android sync ./app-debug.apk --watch',
    '<%= config.bin %> android sync ./app-debug.apk --no-install',
    '<%= config.bin %> android sync ./app-debug.apk --launch-mode RelaunchIfRunning',
    '<%= config.bin %> android sync ./app-debug.apk --basis-cache-dir ./.limrun-cache',
  ];

  static args = {
    path: Args.string({
      description: 'Local APK file to sync.',
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to sync to. Defaults to the last created Android instance.',
    }),
    watch: Flags.boolean({
      description: 'Keep watching the APK file and push changes automatically',
      default: false,
      allowNo: true,
    }),
    install: Flags.boolean({
      description: 'Install the synced APK after each sync',
      default: true,
      allowNo: true,
    }),
    'launch-mode': Flags.string({
      description: 'Launch behavior after install when installation is enabled',
      options: ['ForegroundIfRunning', 'RelaunchIfRunning'],
    }),
    'basis-cache-dir': Flags.string({
      description: 'Directory to use for the client-side delta sync cache.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AndroidSync);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveAndroidInstance(flags.id);
      const id = resolvedInstance.id;
      const { client, disconnect } = await getAndroidInstanceClient(this.client, resolvedInstance);

      this.info(`Syncing APK ${args.path} to instance ${id}...`);
      const syncStart = Date.now();

      const result = await client.syncApp(args.path, {
        watch: flags.watch,
        install: flags.install,
        basisCacheDir: flags['basis-cache-dir'],
        launchMode: flags['launch-mode'] as 'ForegroundIfRunning' | 'RelaunchIfRunning' | undefined,
        onBasisDownload: (sizeBytes?: number) => {
          const downloadSize = sizeBytes === undefined ? '' : ` (${formatBytes(sizeBytes)} download)`;
          this.info(`Fetching Android sync basis from instance${downloadSize}...`);
        },
      });

      const syncDuration = formatDurationMs(Date.now() - syncStart);
      const syncedSize = result.bytesSent !== undefined ? ` (${formatBytes(result.bytesSent)} sent)` : '';
      this.output(`Sync completed in ${syncDuration}${syncedSize}.`);

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
                  `Failed to stop APK watcher cleanly: ${err instanceof Error ? err.message : String(err)}`,
                );
              } finally {
                disconnect();
                resolve();
              }
            })();
          };
          process.on('SIGINT', shutdown);
          process.on('SIGTERM', shutdown);
        });
      } else {
        disconnect();
      }
    });
  }
}
