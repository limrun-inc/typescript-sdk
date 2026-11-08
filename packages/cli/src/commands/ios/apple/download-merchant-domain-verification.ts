import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';
import { savePrivateFile, downloadBytes } from '../../../lib/store-output';

export default appleAction({
  summary: 'Download merchant domain verification',
  flags: {
    platform: Flags.string({ description: 'Developer Portal namespace.', options: ['ios', 'mac'] }),
    id: Flags.string({ description: 'Opaque Apple record ID.', required: true }),
    output: Flags.string({
      description: 'Destination file. Must not exist; written with mode 0600.',
      required: true,
    }),
  },
  run: async (context, flags) =>
    savePrivateFile(flags.output, async () =>
      downloadBytes(
        await apple.downloadAppleMerchantDomainVerification({
          relay: context.relay,
          teamId: context.team!.teamId,
          platform: flags.platform as 'ios' | 'mac' | undefined,
          domainId: flags['id'],
        }),
      ),
    ),
});
