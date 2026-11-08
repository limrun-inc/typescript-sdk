import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'List API keys',
  appStoreConnect: true,
  flags: {},
  run: async (context) => apple.listAppStoreConnectApiKeys({ relay: context.relay }),
});
