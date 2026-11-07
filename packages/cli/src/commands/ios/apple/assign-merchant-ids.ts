import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'Assign merchant IDs',
  description:
    'Replaces the complete assignment set. Read existing assignments before adding one. Does not enable capabilities or regenerate profiles.',
  flags: {
    platform: Flags.string({ description: 'Developer Portal namespace.', options: ['ios', 'mac'] }),
    id: Flags.string({ description: 'Opaque App ID record ID.', required: true }),
    'resource-id': Flags.string({
      description: 'Complete desired set of opaque resource IDs. Repeat for each assignment.',
      multiple: true,
    }),
    clear: Flags.boolean({ description: 'Remove every assignment. Exclusive with --resource-id.' }),
  },
  run: async (context, flags) => {
    if (flags.clear ? flags['resource-id']?.length : !flags['resource-id']?.length)
      throw new Error('Provide --resource-id or --clear, exclusively.');
    return apple.assignAppleMerchantIDs({
      relay: context.relay,
      teamId: context.team!.teamId,
      platform: flags.platform as 'ios' | 'mac' | undefined,
      appIdId: flags.id,
      omcIds: flags['resource-id'] ?? [],
    });
  },
});
