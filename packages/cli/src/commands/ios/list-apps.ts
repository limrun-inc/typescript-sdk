import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  getIosInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class IosListApps extends BaseCommand {
  static summary = 'List installed apps on a running iOS instance';
  static description =
    'List the apps currently installed on a running iOS instance, including bundle identifiers, display names, and install types. Use this before `launch-app` if you need to discover the correct bundle ID.';
  static examples = [
    '<%= config.bin %> ios list-apps',
    '<%= config.bin %> ios list-apps --id <instance-ID>',
    '<%= config.bin %> ios list-apps --json',
  ];

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to inspect. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosListApps);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const id = resolvedInstance.id;
      let apps: any[];

      if (hasActiveSession(id)) {
        apps = (await sendSessionCommand(id, 'list-apps')) as any[];
      } else {
        const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
        try {
          apps = await client.listApps();
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
