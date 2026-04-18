import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { detectInstanceType } from '../../lib/instance-client-factory';
import { loadInstanceCache } from '../../lib/config';

export default class XcodeSync extends BaseCommand {
  static summary = 'Sync local code to an Xcode sandbox';
  static description =
    'Push a local project path (or the current working directory if omitted) to a remote Xcode sandbox with optional watch mode. This works with standalone Xcode instances and can also target an iOS instance with `--xcode` enabled when you pass `--id`.';

  static examples = [
    '<%= config.bin %> xcode sync',
    '<%= config.bin %> xcode sync ./MyProject',
    '<%= config.bin %> xcode sync --id <xcode-instance-ID>',
    '<%= config.bin %> xcode sync --watch',
    '<%= config.bin %> xcode sync ./MyProject --id <ios-instance-ID> --no-install',
  ];

  static args = {
    path: Args.string({
      description: 'Local project path to sync. Defaults to the current working directory.',
      required: false,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description:
        'Xcode instance ID to sync to, or an iOS instance ID with `--xcode` enabled. Defaults to the last created Xcode instance.',
    }),
    watch: Flags.boolean({
      description: 'Keep watching the local project and push changes automatically',
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
      const id = this.resolveId(flags.id);
      const syncPath = args.path ?? process.cwd();
      const xcodeClient = await this.resolveXcodeClient(id);

      this.log(`Syncing ${syncPath} to instance ${id}...`);

      const result = await xcodeClient.sync(syncPath, {
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
      const instance = await this.client.iosInstances.get(id);
      let sandboxUrl = instance.status.sandbox?.xcode?.url;
      let token = instance.status.token;

      if (!sandboxUrl) {
        const cached = loadInstanceCache(id);
        if (cached?.sandboxXcodeUrl) {
          sandboxUrl = cached.sandboxXcodeUrl;
          token = cached.token || token;
        }
      }

      if (!sandboxUrl) {
        this.error(`iOS instance ${id} does not have a Xcode sandbox. Create it with: lim ios create --xcode`);
      }
      return this.client.xcodeInstances.createClient({
        apiUrl: sandboxUrl,
        token,
      });
    }

    const instance = await this.client.xcodeInstances.get(id);
    return this.client.xcodeInstances.createClient({ instance });
  }
}
