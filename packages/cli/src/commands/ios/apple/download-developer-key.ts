import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';
import { savePrivateFile, downloadBytes } from '../../../lib/store-output';

export default appleAction({
  summary: 'Download developer key',
  flags: {
    id: Flags.string({ description: 'Opaque Apple record ID.', required: true }),
    output: Flags.string({
      description: 'Destination file. Must not exist; written with mode 0600.',
      required: true,
    }),
  },
  run: async (context, flags) =>
    savePrivateFile(flags.output, async () =>
      downloadBytes(
        await apple.downloadAppleDeveloperKey({
          relay: context.relay,
          teamId: context.team!.teamId,
          keyId: flags['id'],
        }),
      ),
    ),
});
