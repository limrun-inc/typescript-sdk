import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'Register merchant domain',
  flags: {
    platform: Flags.string({ description: 'Developer Portal namespace.', options: ['ios', 'mac'] }),
    'merchant-id': Flags.string({ description: 'Opaque Apple merchant record ID.', required: true }),
    'domain-name': Flags.string({ description: 'Merchant website domain.', required: true }),
  },
  run: async (context, flags) =>
    apple.registerAppleMerchantDomain({
      relay: context.relay,
      teamId: context.team!.teamId,
      platform: flags.platform as 'ios' | 'mac' | undefined,
      merchantId: flags['merchant-id'],
      domainName: flags['domain-name'],
    }),
});
