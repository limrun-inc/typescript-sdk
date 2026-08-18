import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getAndroidInstanceClient } from '../../lib/instance-client-factory';

export default class AndroidTerminateApp extends BaseCommand {
  static summary = 'Terminate an app on a running Android instance';
  static description =
    'Stop a running app on an Android instance by package name. This is useful when resetting application state or ending a foreground app before another automation step.';
  static examples = [
    '<%= config.bin %> android terminate-app com.example.app',
    '<%= config.bin %> android terminate-app com.example.app --id <instance-ID>',
  ];

  static args = {
    packageName: Args.string({
      description: 'Package name of the running app to terminate',
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to target. Defaults to the last created Android instance.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AndroidTerminateApp);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveAndroidInstance(flags.id);
      const { client, disconnect } = await getAndroidInstanceClient(this.client, resolvedInstance);
      try {
        await client.terminateApp(args.packageName);
      } finally {
        disconnect();
      }
      this.log(`Terminated ${args.packageName}`);
    });
  }
}
