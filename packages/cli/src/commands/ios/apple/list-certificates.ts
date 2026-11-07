import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'List certificates',
  flags: {
    platform: Flags.string({ description: 'Developer Portal namespace.', options: ['ios', 'mac'] }),
    'certificate-kind': Flags.string({
      description: 'development or distribution certificate.',
      options: ['development', 'distribution'],
    }),
  },
  run: async (context, flags) =>
    apple.listAppleCertificates({
      relay: context.relay,
      teamId: context.team!.teamId,
      platform: flags.platform as 'ios' | 'mac' | undefined,
      certificateKind: flags['certificate-kind'] as apple.AppleCertificateKind | undefined,
    }),
});
