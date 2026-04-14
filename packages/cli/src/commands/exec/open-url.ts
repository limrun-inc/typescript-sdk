import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendSessionCommand } from '../../lib/instance-client-factory';

export default class ExecOpenUrl extends BaseCommand {
  static summary = 'Open a URL on a running instance';
  static aliases = ['ios open-url', 'android open-url'];
  static examples = [
    '<%= config.bin %> ios open-url https://example.com',
    '<%= config.bin %> ios open-url https://example.com --id <instance-ID>',
  ];

  static args = {
    url: Args.string({ description: 'URL to open', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'Instance ID (defaults to last created)' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ExecOpenUrl);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
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
