import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'Get the App Store Connect provider ID',
  appStoreConnect: true,
  flags: {},
  run: async (context) => (async () => ({ id: await apple.fetchAppStoreConnectProviderId(context.relay) }))(),
});
