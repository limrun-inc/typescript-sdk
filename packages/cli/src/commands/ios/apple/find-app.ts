import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'Find app',
  appStoreConnect: true,
  flags: {
    'bundle-id': Flags.string({ description: 'Bundle identifier, such as com.example.app.', required: true }),
  },
  run: async (context, flags) => ({
    app: (await apple.findAppStoreConnectApp({ relay: context.relay, bundleId: flags['bundle-id'] })) ?? null,
  }),
});
