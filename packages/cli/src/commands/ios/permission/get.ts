import { Args, Flags } from '@oclif/core';
import type { PrivacyService } from '@limrun/api/ios-client';
import { BaseCommand } from '../../../base-command';
import { getIosInstanceClient } from '../../../lib/instance-client-factory';
import { PRIVACY_SERVICES } from './set';

export default class IosPermissionGet extends BaseCommand {
  static summary = "Read an app's privacy permission on a running iOS instance";
  static description =
    'Print granted, denied, limited, or unset when the app has not asked yet. The notifications permission cannot be read.';
  static examples = [
    '<%= config.bin %> ios permission get com.example.app camera',
    '<%= config.bin %> ios permission get com.example.app photos --json',
  ];

  static args = {
    bundle_id: Args.string({ description: 'Bundle ID of the app.', required: true }),
    service: Args.string({
      description: 'Privacy service.',
      required: true,
      options: PRIVACY_SERVICES.filter((service) => service !== 'notifications'),
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosPermissionGet);
    this.setParsedFlags(flags);
    const service = args.service as Exclude<PrivacyService, 'notifications'>;

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      let status: string;
      try {
        status = await client.getPermission(args.bundle_id, service);
      } finally {
        disconnect();
      }
      this.outputResult(
        { instanceId: resolvedInstance.id, bundleId: args.bundle_id, service, status },
        status,
      );
    });
  }
}
