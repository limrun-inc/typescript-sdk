import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'Delete certificate',
  flags: {
    platform: Flags.string({ description: 'Developer Portal namespace.', options: ['ios', 'mac'] }),
    'certificate-kind': Flags.string({
      description: 'development or distribution certificate.',
      options: ['development', 'distribution'],
    }),
    id: Flags.string({ description: 'Opaque Apple record ID.', required: true }),
  },
  run: async (context, flags) =>
    apple.deleteAppleCertificate({
      relay: context.relay,
      teamId: context.team!.teamId,
      platform: flags.platform as 'ios' | 'mac' | undefined,
      certificateKind: flags['certificate-kind'] as apple.AppleCertificateKind | undefined,
      certificateId: flags.id,
    }),
});
