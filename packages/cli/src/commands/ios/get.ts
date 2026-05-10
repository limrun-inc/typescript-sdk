import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class IosGet extends BaseCommand {
  static summary = 'Get details for a specific iOS instance';
  static description =
    'Fetch detailed metadata for a single iOS instance, including region, state, and display name. Use `--json` to inspect the full API response.';
  static examples = ['<%= config.bin %> ios get', '<%= config.bin %> ios get <ID> --json'];

  static args = {
    id: Args.string({
      description: 'iOS instance ID to fetch. Defaults to the last created iOS instance.',
      required: false,
    }),
  };

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosGet);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(args.id);
      const instance = await this.client.iosInstances.get(resolvedInstance.id);
      if (flags.json) {
        this.outputJson(instance);
      } else {
        const signedStreamUrl = this.signedStreamUrl(instance.status);
        this.output(`ID: ${instance.metadata.id}`);
        this.output(`Name: ${instance.metadata.displayName || ''}`);
        this.output(`Region: ${instance.spec.region}`);
        this.output(`State: ${instance.status.state}`);
        this.output(`Console URL: ${this.consoleStreamUrl(instance.metadata.id)}`);
        if (instance.status.apiUrl) this.output(`API URL: ${instance.status.apiUrl}`);
        if (instance.status.sandbox?.xcode?.url) {
          this.output(`Xcode Sandbox URL: ${instance.status.sandbox.xcode.url}`);
        }
        if (signedStreamUrl) this.output(`Signed Stream URL: ${signedStreamUrl}`);
      }
    });
  }
}
