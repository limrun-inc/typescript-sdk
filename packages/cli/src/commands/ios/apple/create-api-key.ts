import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'Create API key',
  appStoreConnect: true,
  flags: {
    'all-apps-visible': Flags.boolean({
      description: 'Allow the key to see every app.',
      allowNo: true,
      default: true,
    }),
    nickname: Flags.string({ description: 'API key display name.', required: true }),
    role: Flags.string({
      description: 'Role for the API key. Repeat for several roles.',
      options: ['ADMIN', 'APP_MANAGER', 'CUSTOMER_SUPPORT', 'DEVELOPER', 'FINANCE', 'MARKETING', 'SALES'],
      multiple: true,
    }),
  },
  run: async (context, flags) =>
    apple.createAppStoreConnectApiKey({
      relay: context.relay,
      nickname: flags.nickname,
      allAppsVisible: flags['all-apps-visible'],
      roles: flags.role as apple.AppStoreConnectApiKeyRole[] | undefined,
    }),
});
