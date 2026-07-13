import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { loadLastAndroidInstance } from '../../lib/config';

export default class AndroidGet extends BaseCommand {
  static summary = 'Get details for a specific Android instance';
  static description =
    'Fetch detailed metadata for a single Android instance, including region, state, and display name. Falls back to listing all Android instances when no ID is given and no recent instance is remembered. Use `--json` to inspect the full API response.';
  static examples = ['<%= config.bin %> android get', '<%= config.bin %> android get <ID> --json'];

  static args = {
    id: Args.string({
      description:
        'Android instance ID to fetch. Defaults to the last created Android instance; lists all instances when none is remembered.',
      required: false,
    }),
  };

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AndroidGet);
    this.setParsedFlags(flags);

    if (!args.id && !loadLastAndroidInstance()) {
      this.info('No recent Android instance found. Listing Android instances instead.');
      await this.runListFallback('android:list');
      return;
    }

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveAndroidInstance(args.id);
      const instance = await this.client.androidInstances.get(resolvedInstance.id);
      if (flags.json) {
        this.outputJson(instance);
      } else {
        const signedStreamUrl = this.signedStreamUrl(instance.status);
        this.output(`ID: ${instance.metadata.id}`);
        this.output(`Name: ${instance.metadata.displayName || ''}`);
        this.output(`Region: ${instance.spec.region}`);
        this.output(`State: ${instance.status.state}`);
        if (instance.status.terminationReason)
          this.output(`Termination Reason: ${instance.status.terminationReason}`);
        this.output(`Console URL: ${this.consoleStreamUrl(instance.metadata.id)}`);
        if (instance.status.apiUrl) this.output(`API URL: ${instance.status.apiUrl}`);
        if (instance.status.adbWebSocketUrl)
          this.output(`ADB WebSocket URL: ${instance.status.adbWebSocketUrl}`);
        if (signedStreamUrl) this.output(`Signed Stream URL: ${signedStreamUrl}`);
      }
    });
  }
}
