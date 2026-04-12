import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendSessionCommand } from '../../lib/instance-client-factory';

export default class ExecOpenUrl extends BaseCommand {
  static summary = 'Open a URL on a running instance';
  static examples = ['<%= config.bin %> exec open-url <instance-ID> https://example.com'];

  static args = {
    id: Args.string({ description: 'Instance ID', required: true }),
    url: Args.string({ description: 'URL to open', required: true }),
  };

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ExecOpenUrl);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      if (hasActiveSession(args.id)) {
        await sendSessionCommand(args.id, 'open-url', [args.url]);
      } else {
        const { client, disconnect } = await getInstanceClient(this.client, args.id);
        try {
          await (client as any).openUrl(args.url);
        } finally {
          disconnect();
        }
      }
      this.log(`Opened URL: ${args.url}`);
    });
  }
}
