import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendSessionCommand } from '../../lib/instance-client-factory';

export default class ExecOpenUrl extends BaseCommand {
  static summary = 'Open a URL on a running instance';
  static description =
    'Open a web URL or application deep link on a running iOS or Android instance. This is useful for browser navigation, deep-link testing, and app routing flows.';
  static aliases = ['ios open-url', 'android open-url'];
  static examples = [
    '<%= config.bin %> ios open-url https://example.com',
    '<%= config.bin %> ios open-url https://example.com --id <instance-ID>',
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
      description: 'Instance ID to target. Defaults to the last created instance of the command alias type.',
    }),
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
