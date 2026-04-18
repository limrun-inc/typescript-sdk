import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  detectInstanceType,
  getInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class IosOpenUrl extends BaseCommand {
  static summary = 'Open a URL on a running iOS instance';
  static description =
    'Open a web URL or application deep link on a running iOS instance. This is useful for browser navigation, deep-link testing, and app routing flows.';
  static examples = [
    '<%= config.bin %> ios open-url https://example.com',
    '<%= config.bin %> ios open-url myapp://settings --id <instance-ID>',
  ];

  static args = {
    url: Args.string({
      description: 'URL or deep link to open, such as https://example.com or myapp://settings',
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosOpenUrl);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (detectInstanceType(id) !== 'ios') {
        this.error('ios open-url only supports iOS instances');
      }

      if (hasActiveSession(id)) {
        await sendSessionCommand(id, 'open-url', [args.url]);
      } else {
        const { type, client, disconnect } = await getInstanceClient(this.client, id);
        try {
          if (type !== 'ios') {
            this.error('ios open-url only supports iOS instances');
          }
          await (client as any).openUrl(args.url);
        } finally {
          disconnect();
        }
      }
      this.log(`Opened URL: ${args.url}`);
    });
  }
}
