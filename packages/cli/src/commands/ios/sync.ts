import { Args, Flags } from '@oclif/core';
import { Ios } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import { detectInstanceType } from '../../lib/instance-client-factory';

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
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosSync);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (detectInstanceType(id) !== 'ios') {
        this.error('ios sync only supports iOS instances. Use `lim xcode sync` for source code syncing.');
      }

      const instance = await this.client.iosInstances.get(id);
      if (!instance.status.apiUrl) {
        this.error(`Instance ${id} does not have an apiUrl. Is it ready?`);
      }

      const syncPath = args.path ?? process.cwd();
      const iosClient = await Ios.createInstanceClient({
        apiUrl: instance.status.apiUrl,
        token: instance.status.token,
      });

      this.log(`Syncing app bundle ${syncPath} to instance ${id}...`);

      const result = await iosClient.syncApp(syncPath, {
        watch: flags.watch,
        install: flags.install,
        launchMode: flags['launch-mode'] as 'ForegroundIfRunning' | 'RelaunchIfRunning' | undefined,
      });

      this.log('App sync complete.');
      if (result.installedBundleId) {
        this.log(`Installed bundle ID: ${result.installedBundleId}`);
      }

      if (flags.watch && result.stopWatching) {
        this.log('Watching for changes. Press Ctrl+C to stop.');
        await new Promise<void>((resolve) => {
          const keepAlive = setInterval(() => {}, 1 << 30);
          const shutdown = () => {
            clearInterval(keepAlive);
            result.stopWatching!();
            iosClient.disconnect();
            resolve();
          };
          process.on('SIGINT', shutdown);
          process.on('SIGTERM', shutdown);
        });
      } else {
        iosClient.disconnect();
      }
    });
  }
}
