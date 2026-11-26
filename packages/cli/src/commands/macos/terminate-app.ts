import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class MacosTerminateApp extends BaseCommand {
  static summary = 'Terminate an app on a macOS instance';
  static description =
    'Stop every process of an app in the macOS guest by bundle ID, with SIGTERM and then SIGKILL after five seconds. ' +
    'It succeeds when the app is not running.';
  static examples = ['<%= config.bin %> macos terminate-app com.example.app'];

  static args = {
    bundleId: Args.string({ description: 'Bundle identifier of the app', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'macOS instance ID. Defaults to the last created macOS instance.' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MacosTerminateApp);
    this.setParsedFlags(flags);
    await this.withAuth(async () => {
      const { client } = await this.resolveMacosClient(flags.id);
      await client.terminateApp(args.bundleId);
      this.outputResult({ ok: true, bundleId: args.bundleId }, `Terminated ${args.bundleId}`);
    });
  }
}
