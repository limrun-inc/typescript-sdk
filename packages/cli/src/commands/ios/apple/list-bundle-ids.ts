import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'List bundle IDs',
  flags: {
    platform: Flags.string({ description: 'Developer Portal namespace.', options: ['ios', 'mac'] }),
    search: Flags.string({ description: 'Filter bundle IDs by identifier or name.' }),
  },
  run: async (context, flags) =>
    apple.listAppleBundleIDs({
      relay: context.relay,
      teamId: context.team!.teamId,
      platform: flags.platform as 'ios' | 'mac' | undefined,
      search: flags['search'],
    }),
});
