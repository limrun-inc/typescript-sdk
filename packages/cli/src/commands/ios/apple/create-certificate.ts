import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';
import { readFile } from 'node:fs/promises';

export default appleAction({
  summary: 'Create certificate',
  flags: {
    platform: Flags.string({ description: 'Developer Portal namespace.', options: ['ios', 'mac'] }),
    'certificate-kind': Flags.string({
      description: 'development or distribution certificate.',
      options: ['development', 'distribution'],
    }),
    csr: Flags.string({ description: 'Path to a PEM certificate signing request.', required: true }),
  },
  run: async (context, flags) =>
    apple.createAppleCertificate({
      relay: context.relay,
      teamId: context.team!.teamId,
      platform: flags.platform as 'ios' | 'mac' | undefined,
      certificateKind: flags['certificate-kind'] as apple.AppleCertificateKind | undefined,
      csrPEM: await readFile(flags.csr, 'utf8'),
    }),
});
