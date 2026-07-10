import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getIosInstanceClient } from '../../lib/instance-client-factory';
import { formatDurationMs } from '../../lib/duration';
import { formatBytes } from '../../lib/bytes';

export default class IosSync extends BaseCommand {
  static summary = 'Sync a built app bundle to a running iOS instance';
  static description =
    'Push a built `.app` bundle folder (or the current working directory if omitted) to a running iOS instance and optionally install or relaunch it after each sync. Use `xcode sync` for source code and project file syncing.';

  static examples = [
    '<%= config.bin %> ios sync ./Build/Products/Debug-iphonesimulator/MyApp.app',
    '<%= config.bin %> ios sync ./MyApp.app --id <ios-instance-ID>',
    '<%= config.bin %> ios sync ./MyApp.app --watch',
    '<%= config.bin %> ios sync ./MyApp.app --no-install',
    '<%= config.bin %> ios sync ./MyApp.app --launch-mode RelaunchIfRunning',
    '<%= config.bin %> ios sync ./MyApp.app --basis-cache-dir ./.limrun-cache',
  ];

  static args = {
    path: Args.string({
      description: 'Local `.app` bundle folder to sync. Defaults to the current working directory.',
      required: false,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to sync to. Defaults to the last created iOS instance.',
    }),
    watch: Flags.boolean({
      description: 'Keep watching the app bundle folder and push changes automatically',
      default: false,
      allowNo: true,
    }),
    install: Flags.boolean({
      description: 'Install the synced app after each sync',
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
    const { args, flags } = await this.parse(IosSync);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const id = resolvedInstance.id;
      const syncPath = args.path ?? process.cwd();
      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);

      this.info(`Syncing app bundle ${syncPath} to instance ${id}...`);

      const result = await client.syncApp(syncPath, {
        watch: flags.watch,
        install: flags.install,
        basisCacheDir: flags['basis-cache-dir'],
        launchMode: flags['launch-mode'] as 'ForegroundIfRunning' | 'RelaunchIfRunning' | undefined,
        onSyncComplete: (event) => {
          this.output(
            `Sync completed in ${formatDurationMs(event.durationMs)} (${formatBytes(event.bytesSent)} sent).`,
          );
        },
      });

      if (result.installedBundleId) {
        this.output(`Installed bundle ID: ${result.installedBundleId}`);
      }

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
                  `Failed to stop app watcher cleanly: ${err instanceof Error ? err.message : String(err)}`,
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
