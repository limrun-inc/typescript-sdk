import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'Register device',
  flags: {
    platform: Flags.string({ description: 'Developer Portal namespace.', options: ['ios', 'mac'] }),
    udid: Flags.string({ description: 'Device UDID.', required: true }),
    name: Flags.string({ description: 'Resource display name.' }),
  },
  run: async (context, flags) =>
    apple.registerAppleDevice({
      relay: context.relay,
      teamId: context.team!.teamId,
      platform: flags.platform as 'ios' | 'mac' | undefined,
      deviceUDID: flags['udid'],
      name: flags['name'],
    }),
});
