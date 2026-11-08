import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'List devices',
  flags: {
    platform: Flags.string({ description: 'Developer Portal namespace.', options: ['ios', 'mac'] }),
    udid: Flags.string({ description: 'Device UDID.' }),
    'device-class': Flags.string({ description: 'Apple device class filter.' }),
    'include-disabled': Flags.boolean({ description: 'Include disabled devices.' }),
  },
  run: async (context, flags) =>
    apple.listAppleDevices({
      relay: context.relay,
      teamId: context.team!.teamId,
      platform: flags.platform as 'ios' | 'mac' | undefined,
      deviceUDID: flags['udid'],
      deviceClass: flags['device-class'],
      includeDisabled: flags['include-disabled'],
    }),
});
