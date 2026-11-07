import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'Ensure certificate',
  flags: {
    'certificate-kind': Flags.string({
      description: 'development or distribution certificate.',
      options: ['development', 'distribution'],
    }),
    'common-name': Flags.string({ description: 'Certificate common name.' }),
  },
  run: async (context, flags) => {
    const result = await apple.ensureAppleCertificateSecret({
      relay: context.relay,
      teamId: context.team!.teamId,
      secretStore: context.store,
      certificateKind: flags['certificate-kind'] as apple.AppleCertificateKind | undefined,
      commonName: flags['common-name'],
    });
    return {
      certificateId: result.certificateId,
      created: result.created,
      directory: context.store.directory,
    };
  },
});
