import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'Delete app group',
  flags: {
    id: Flags.string({ description: 'Opaque Apple record ID.', required: true }),
  },
  run: async (context, flags) =>
    apple.deleteAppleAppGroup({
      relay: context.relay,
      teamId: context.team!.teamId,
      applicationGroup: flags['id'],
    }),
});
