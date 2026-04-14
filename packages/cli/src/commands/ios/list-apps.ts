import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendSessionCommand } from '../../lib/instance-client-factory';

export default class IosListApps extends BaseCommand {
  static summary = 'List installed apps on a running iOS instance';
  static aliases = ['exec list-apps'];
  static examples = ['<%= config.bin %> ios list-apps <instance-ID>'];

  static args = {
    id: Args.string({ description: 'Instance ID', required: true }),
  };

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosListApps);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      let apps: any[];

      if (hasActiveSession(args.id)) {
        apps = (await sendSessionCommand(args.id, 'list-apps')) as any[];
      } else {
        const { type, client, disconnect } = await getInstanceClient(this.client, args.id);
        if (type !== 'ios') {
          disconnect();
          this.error('list-apps is only supported on iOS instances');
        }
        try {
          apps = await (client as any).listApps();
        } finally {
          disconnect();
        }
      }

      if (flags.json) {
        this.outputJson(apps);
      } else {
        const rows = apps.map((a: any) => [a.bundleId, a.name, a.installType]);
        this.outputTable(['Bundle ID', 'Name', 'Install Type'], rows);
      }
    });
  }
}
