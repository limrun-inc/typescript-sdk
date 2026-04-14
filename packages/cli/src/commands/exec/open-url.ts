import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendSessionCommand } from '../../lib/instance-client-factory';

export default class ExecOpenUrl extends BaseCommand {
  static summary = 'Open a URL on a running instance';
  static aliases = ['ios open-url', 'android open-url'];
  static examples = ['<%= config.bin %> ios open-url <instance-ID> https://example.com'];

  static args = {
    url: Args.string({ description: 'URL to open', required: true }),
    id: Args.string({ description: 'Instance ID (defaults to last created)', required: false }),
  };

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ExecOpenUrl);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(args.id);
      if (hasActiveSession(id)) {
        await sendSessionCommand(id, 'open-url', [args.url]);
      } else {
        const { client, disconnect } = await getInstanceClient(this.client, id);
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
