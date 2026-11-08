import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'Save profile',
  flags: {
    id: Flags.string({ description: 'Opaque Apple record ID.', required: true }),
  },
  run: async (context, flags) => {
    const saved = await apple.saveAppleProfileSecret({
      relay: context.relay,
      teamId: context.team!.teamId,
      profileId: flags.id,
      secretStore: context.store,
    });
    return { type: saved.type, name: saved.name, directory: context.store.directory };
  },
});
