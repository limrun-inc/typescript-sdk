import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'List vendor numbers',
  appStoreConnect: true,
  flags: {},
  run: async (context) => apple.listAppStoreConnectVendorNumbers({ relay: context.relay }),
});
