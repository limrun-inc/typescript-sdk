import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'Create merchant ID',
  flags: {
    platform: Flags.string({ description: 'Developer Portal namespace.', options: ['ios', 'mac'] }),
    identifier: Flags.string({ description: 'Identifier string for the resource.', required: true }),
    name: Flags.string({ description: 'Resource display name.' }),
  },
  run: async (context, flags) =>
    apple.createAppleMerchantID({
      relay: context.relay,
      teamId: context.team!.teamId,
      platform: flags.platform as 'ios' | 'mac' | undefined,
      identifier: flags['identifier'],
      name: flags['name'],
    }),
});
