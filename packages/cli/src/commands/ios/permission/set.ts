import { Args, Flags } from '@oclif/core';
import type { PermissionStatus, PrivacyService } from '@limrun/api/ios-client';
import { BaseCommand } from '../../../base-command';
import { getIosInstanceClient } from '../../../lib/instance-client-factory';

export const PRIVACY_SERVICES: PrivacyService[] = [
  'calendar',
  'camera',
  'contacts',
  'faceid',
  'health',
  'homekit',
  'medialibrary',
  'microphone',
  'motion',
  'notifications',
  'photos',
  'reminders',
  'siri',
  'speech',
  'usertracking',
];

export default class IosPermissionSet extends BaseCommand {
  static summary = "Set an app's privacy permission on a running iOS instance";
  static description =
    'Grant, deny or reset a privacy permission so the app never shows the system prompt. `limited` applies only to photos and `critical` (critical alerts allowed too) only to notifications. `unset` removes the decision, so the app asks again. Setting notifications restarts SpringBoard, which closes every running app. For location, use `lim ios simctl -- privacy booted grant location <bundle-id>`.';
  static examples = [
    '<%= config.bin %> ios permission set com.example.app camera granted',
    '<%= config.bin %> ios permission set com.example.app photos limited',
    '<%= config.bin %> ios permission set com.example.app notifications denied',
    '<%= config.bin %> ios permission set com.example.app faceid unset --id <instance-ID>',
  ];

  static args = {
    bundle_id: Args.string({ description: 'Bundle ID of the app.', required: true }),
    service: Args.string({ description: 'Privacy service.', required: true, options: PRIVACY_SERVICES }),
    status: Args.string({
      description: 'Permission status.',
      required: true,
      options: ['granted', 'denied', 'limited', 'critical', 'unset'],
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosPermissionSet);
    this.setParsedFlags(flags);
    const service = args.service as PrivacyService;
    const status = args.status as PermissionStatus;

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        await client.setPermission(args.bundle_id, service, status);
      } finally {
        disconnect();
      }
      this.outputResult(
        { ok: true, instanceId: resolvedInstance.id, bundleId: args.bundle_id, service, status },
        `Set ${service} to ${status} for ${args.bundle_id}`,
      );
    });
  }
}
