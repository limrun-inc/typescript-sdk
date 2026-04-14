import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../base-command';
import { detectInstanceType } from '../lib/instance-client-factory';
import { loadInstanceCache } from '../lib/config';

export default class Sync extends BaseCommand {
  static summary = 'Sync local code to a Xcode sandbox';
  static aliases = ['ios sync', 'xcode sync'];
  static description =
    'Pushes local source code to a remote Xcode sandbox with optional watch mode. ' +
    'Works with both standalone Xcode instances and iOS instances that have --xcode enabled.';

  static examples = [
    '<%= config.bin %> sync ./MyProject',
    '<%= config.bin %> sync ./MyProject <xcode-instance-ID>',
    '<%= config.bin %> sync ./MyProject --no-watch',
  ];

  static args = {
    path: Args.string({ description: 'Local project path to sync', required: true }),
    id: Args.string({ description: 'Xcode or iOS instance ID (defaults to last created)', required: false }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    watch: Flags.boolean({ description: 'Watch for changes and re-sync', default: true, allowNo: true }),
    install: Flags.boolean({ description: 'Install after syncing', default: true, allowNo: true }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Sync);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(args.id);
      const xcodeClient = await this.resolveXcodeClient(id);

      this.log(`Syncing ${args.path} to instance ${id}...`);

      const result = await xcodeClient.sync(args.path, {
        watch: flags.watch,
        install: flags.install,
      });

      this.log('Sync complete.');

      if (flags.watch && result.stopWatching) {
        this.log('Watching for changes. Press Ctrl+C to stop.');
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

  private async resolveXcodeClient(id: string) {
    const type = detectInstanceType(id).toString();

    if (type === 'ios') {
      // iOS instance with Xcode sandbox
      const instance = await this.client.iosInstances.get(id);
      let sandboxUrl = instance.status.sandbox?.xcode?.url;
      let token = instance.status.token;

      // The API doesn't return sandbox URL on get — check local cache
      if (!sandboxUrl) {
        const cached = loadInstanceCache(id);
        if (cached?.sandboxXcodeUrl) {
          sandboxUrl = cached.sandboxXcodeUrl;
          token = cached.token || token;
        }
      }

      if (!sandboxUrl) {
        this.error(`iOS instance ${id} does not have a Xcode sandbox. Create it with: lim run ios --xcode`);
      }
      return this.client.xcodeInstances.createClient({
        apiUrl: sandboxUrl,
        token,
      });
    }

    // Standalone Xcode instance
    const instance = await this.client.xcodeInstances.get(id);
    return this.client.xcodeInstances.createClient({ instance });
  }
}
