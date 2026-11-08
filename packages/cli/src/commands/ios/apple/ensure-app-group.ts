import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'Ensure app group',
  flags: {
    identifier: Flags.string({ description: 'Identifier string for the resource.', required: true }),
    name: Flags.string({ description: 'Resource display name.' }),
  },
  run: async (context, flags) =>
    apple.ensureAppleAppGroup({
      relay: context.relay,
      teamId: context.team!.teamId,
      identifier: flags['identifier'],
      name: flags['name'],
    }),
});
