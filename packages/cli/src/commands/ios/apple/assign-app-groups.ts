import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'Assign app groups',
  description:
    'Replaces the complete assignment set. Read existing assignments before adding one. Does not enable capabilities or regenerate profiles.',
  flags: {
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
    return apple.assignAppleAppGroups({
      relay: context.relay,
      teamId: context.team!.teamId,
      appIdId: flags.id,
      applicationGroups: flags['resource-id'] ?? [],
    });
  },
});
