import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'List pending agreements',
  flags: {
    language: Flags.string({ description: 'Agreement language code. Defaults to en.' }),
  },
  run: async (context, flags) =>
    apple.listApplePendingAgreements({
      relay: context.relay,
      teamId: context.team!.teamId,
      language: flags['language'],
    }),
});
