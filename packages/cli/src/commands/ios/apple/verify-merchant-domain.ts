import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'Verify merchant domain',
  flags: {
    platform: Flags.string({ description: 'Developer Portal namespace.', options: ['ios', 'mac'] }),
    id: Flags.string({ description: 'Opaque Apple record ID.', required: true }),
  },
  run: async (context, flags) =>
    apple.verifyAppleMerchantDomain({
      relay: context.relay,
      teamId: context.team!.teamId,
      platform: flags.platform as 'ios' | 'mac' | undefined,
      domainId: flags['id'],
    }),
});
