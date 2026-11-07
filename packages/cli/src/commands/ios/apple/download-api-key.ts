import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';
import { savePrivateFile } from '../../../lib/store-output';

export default appleAction({
  summary: 'Download API key',
  appStoreConnect: true,
  flags: {
    id: Flags.string({ description: 'Opaque Apple record ID.', required: true }),
    output: Flags.string({ description: 'Destination .p8 file. Must not exist.', required: true }),
  },
  run: async (context, flags) =>
    savePrivateFile(
      flags.output,
      async () =>
        (await apple.downloadAppStoreConnectApiKeyPrivateKey({ relay: context.relay, keyId: flags.id }))
          .privateKeyPem,
    ),
});
