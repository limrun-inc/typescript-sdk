import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../base-command';

export default class Sync extends BaseCommand {
  static summary = 'Sync local code to a Xcode instance';
  static description = 'Pushes local source code to a remote Xcode sandbox with optional watch mode.';

  static examples = [
    '<%= config.bin %> sync <xcode-instance-ID> ./MyProject',
    '<%= config.bin %> sync <xcode-instance-ID> ./MyProject --no-watch',
  ];

  static args = {
    id: Args.string({ description: 'Xcode instance ID', required: true }),
    path: Args.string({ description: 'Local project path to sync', required: true }),
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
      const instance = await this.client.xcodeInstances.get(args.id);
      const xcodeClient = await this.client.xcodeInstances.createClient({ instance });

      this.log(`Syncing ${args.path} to Xcode instance ${args.id}...`);

      const result = await xcodeClient.sync(args.path, {
        watch: flags.watch,
        install: flags.install,
      });

      this.log('Sync complete.');

      if (flags.watch && result.stopWatching) {
        this.log('Watching for changes. Press Ctrl+C to stop.');
        await new Promise<void>((resolve) => {
          process.on('SIGINT', () => {
            result.stopWatching!();
            resolve();
          });
          process.on('SIGTERM', () => {
            result.stopWatching!();
            resolve();
          });
        });
      }
    });
  }
}
