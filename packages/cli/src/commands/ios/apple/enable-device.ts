import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'Enable device',
  flags: {
    platform: Flags.string({ description: 'Developer Portal namespace.', options: ['ios', 'mac'] }),
    id: Flags.string({ description: 'Opaque Apple record ID.', required: true }),
    udid: Flags.string({ description: 'Device UDID.', required: true }),
  },
  run: async (context, flags) =>
    apple.enableAppleDevice({
      relay: context.relay,
      teamId: context.team!.teamId,
      platform: flags.platform as 'ios' | 'mac' | undefined,
      deviceId: flags['id'],
      deviceUDID: flags['udid'],
    }),
});
