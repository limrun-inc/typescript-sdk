import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'List merchant domains',
  flags: {
    platform: Flags.string({ description: 'Developer Portal namespace.', options: ['ios', 'mac'] }),
    'merchant-id': Flags.string({ description: 'Opaque Apple merchant record ID.', required: true }),
  },
  run: async (context, flags) =>
    apple.listAppleMerchantDomains({
      relay: context.relay,
      teamId: context.team!.teamId,
      platform: flags.platform as 'ios' | 'mac' | undefined,
      merchantId: flags['merchant-id'],
    }),
});
