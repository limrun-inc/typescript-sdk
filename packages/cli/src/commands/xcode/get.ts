import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class XcodeGet extends BaseCommand {
  static summary = 'Get details for a specific Xcode instance';
  static description =
    'Fetch detailed metadata for a single Xcode sandbox instance, including region, state, and display name. Use `--json` to inspect the full API response.';
  static examples = ['<%= config.bin %> xcode get', '<%= config.bin %> xcode get <ID> --json'];

  static args = {
    id: Args.string({
      description: 'Xcode instance ID to fetch. Defaults to the last created Xcode target.',
      required: false,
    }),
  };

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(XcodeGet);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const target = await this.resolveXcodeTarget(args.id);
      if (target.type === 'ios') {
        const instance = await this.client.iosInstances.get(target.id);
        if (flags.json) {
          this.outputJson(instance);
        } else {
          const signedStreamUrl = this.signedStreamUrl(instance.status);
          this.output(`ID: ${instance.metadata.id}`);
          this.output(`Type: iOS with Xcode sandbox`);
          this.output(`Name: ${instance.metadata.displayName || ''}`);
          this.output(`Region: ${instance.spec.region}`);
          this.output(`State: ${instance.status.state}`);
          this.output(`Console URL: ${this.consoleStreamUrl(instance.metadata.id)}`);
          if (instance.status.sandbox?.xcode?.url) {
            this.output(`Xcode Sandbox URL: ${instance.status.sandbox.xcode.url}`);
          }
          if (signedStreamUrl) this.output(`Signed Stream URL: ${signedStreamUrl}`);
        }
        return;
      }

      if (flags.json) {
        this.outputJson(target);
      } else {
        this.output(`ID: ${target.id}`);
        this.output(`Type: Xcode sandbox`);
        this.output(`Name: ${target.metadata?.displayName || ''}`);
        this.output(`Region: ${target.spec?.region || ''}`);
        this.output(`State: ${target.status?.state || ''}`);
        this.output(`Console URL: ${this.consoleStreamUrl(target.id)}`);
        if (target.apiUrl) this.output(`API URL: ${target.apiUrl}`);
      }
    });
  }
}
