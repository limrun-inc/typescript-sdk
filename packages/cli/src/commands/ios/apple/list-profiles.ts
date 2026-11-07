import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'List profiles',
  flags: {
    platform: Flags.string({ description: 'Developer Portal namespace.', options: ['ios', 'mac'] }),
    'profile-kind': Flags.string({
      description: 'Provisioning profile kind.',
      options: ['development', 'adhoc', 'appstore'],
    }),
    'bundle-id': Flags.string({ description: 'Bundle identifier, such as com.example.app.' }),
  },
  run: async (context, flags) =>
    apple.listAppleProfiles({
      relay: context.relay,
      teamId: context.team!.teamId,
      platform: flags.platform as 'ios' | 'mac' | undefined,
      profileKind: flags['profile-kind'] as apple.AppleProfileKind | undefined,
      bundleId: flags['bundle-id'],
    }),
});
