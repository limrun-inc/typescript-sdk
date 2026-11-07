import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'Create app',
  appStoreConnect: true,
  flags: {
    'bundle-id': Flags.string({ description: 'Bundle identifier, such as com.example.app.', required: true }),
    name: Flags.string({ description: 'Resource display name.', required: true }),
    sku: Flags.string({ description: 'Unique app SKU. Defaults to the bundle identifier.' }),
    'primary-locale': Flags.string({ description: 'Primary App Store locale. Defaults to en-US.' }),
    'version-string': Flags.string({ description: 'First App Store version. Defaults to 1.0.' }),
  },
  run: async (context, flags) =>
    apple.createAppStoreConnectApp({
      relay: context.relay,
      bundleId: flags['bundle-id'],
      name: flags['name'],
      sku: flags['sku'],
      primaryLocale: flags['primary-locale'],
      versionString: flags['version-string'],
    }),
});
