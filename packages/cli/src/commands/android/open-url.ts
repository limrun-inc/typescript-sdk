import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  detectInstanceType,
  getInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class AndroidOpenUrl extends BaseCommand {
  static summary = 'Open a URL on a running Android instance';
  static description =
    'Open a web URL or application deep link on a running Android instance. This is useful for browser navigation, deep-link testing, and app routing flows.';
  static examples = [
    '<%= config.bin %> android open-url https://example.com',
    '<%= config.bin %> android open-url myapp://settings --id <instance-ID>',
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
      description: 'Android instance ID to target. Defaults to the last created Android instance.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AndroidOpenUrl);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (detectInstanceType(id) !== 'android') {
        this.error('android open-url only supports Android instances');
      }

      if (hasActiveSession(id)) {
        await sendSessionCommand(id, 'open-url', [args.url]);
      } else {
        const { type, client, disconnect } = await getInstanceClient(this.client, id);
        try {
          if (type !== 'android') {
            this.error('android open-url only supports Android instances');
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
