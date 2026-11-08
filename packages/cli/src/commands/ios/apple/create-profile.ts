import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'Create profile',
  flags: {
    platform: Flags.string({ description: 'Developer Portal namespace.', options: ['ios', 'mac'] }),
    'app-id': Flags.string({ description: 'Opaque App ID record ID.', required: true }),
    'certificate-id': Flags.string({
      description: 'Certificate ID. Repeat for each certificate.',
      required: true,
      multiple: true,
    }),
    'device-id': Flags.string({
      description: 'Device record ID. Repeat to retain all desired devices.',
      multiple: true,
    }),
    'profile-kind': Flags.string({
      description: 'Provisioning profile kind.',
      options: ['development', 'adhoc', 'appstore'],
    }),
    'bundle-id': Flags.string({ description: 'Bundle identifier, such as com.example.app.', required: true }),
    name: Flags.string({ description: 'Resource display name.' }),
  },
  run: async (context, flags) =>
    apple.createAppleProfile({
      relay: context.relay,
      teamId: context.team!.teamId,
      platform: flags.platform as 'ios' | 'mac' | undefined,
      profileKind: flags['profile-kind'] as apple.AppleProfileKind | undefined,
      appIdId: flags['app-id'],
      certificateIds: flags['certificate-id'],
      deviceIds: flags['device-id'],
      bundleId: flags['bundle-id'],
      name: flags.name,
    }),
});
