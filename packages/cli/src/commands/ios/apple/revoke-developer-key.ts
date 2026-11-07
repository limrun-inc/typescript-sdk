import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'Revoke developer key',
  flags: {
    id: Flags.string({ description: 'Opaque Apple record ID.', required: true }),
  },
  run: async (context, flags) =>
    apple.revokeAppleDeveloperKey({ relay: context.relay, teamId: context.team!.teamId, keyId: flags['id'] }),
});
