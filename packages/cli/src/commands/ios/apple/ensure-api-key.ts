import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'Ensure API key',
  appStoreConnect: true,
  flags: {
    nickname: Flags.string({ description: 'API key display name.', required: true }),
    role: Flags.string({
      description: 'Role for the API key. Repeat for several roles.',
      options: ['ADMIN', 'APP_MANAGER', 'CUSTOMER_SUPPORT', 'DEVELOPER', 'FINANCE', 'MARKETING', 'SALES'],
      multiple: true,
    }),
  },
  run: async (context, flags) => {
    const result = await apple.ensureAppStoreConnectApiKeySecret({
      relay: context.relay,
      teamId: context.team!.teamId,
      providerId: context.team!.providerId,
      secretStore: context.store,
      nickname: flags.nickname,
      roles: flags.role as apple.AppStoreConnectApiKeyRole[] | undefined,
    });
    return { keyId: result.keyId, created: result.created, directory: context.store.directory };
  },
});
