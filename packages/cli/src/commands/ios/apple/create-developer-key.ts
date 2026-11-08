import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'Create developer key',
  flags: {
    name: Flags.string({ description: 'Resource display name.', required: true }),
    apns: Flags.boolean({ description: 'Enable team-scoped APNs for development and production.' }),
    'device-check': Flags.boolean({ description: 'Enable DeviceCheck.' }),
    'music-id': Flags.string({ description: 'Opaque Apple Music ID.' }),
  },
  run: async (context, flags) =>
    apple.createAppleDeveloperKey({
      relay: context.relay,
      teamId: context.team!.teamId,
      name: flags['name'],
      apns: flags['apns'],
      deviceCheck: flags['device-check'],
      musicId: flags['music-id'],
    }),
});
