import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'Update app service',
  flags: {
    id: Flags.string({ description: 'Opaque App ID record ID.', required: true }),
    'feature-type': Flags.string({
      description: 'Apple capability ID, such as push or APG3427HIY.',
      required: true,
    }),
    'feature-value': Flags.string({
      description: 'true or false for a boolean, otherwise a string.',
      required: true,
    }),
  },
  run: async (context, flags) =>
    apple.updateAppleAppService({
      relay: context.relay,
      teamId: context.team!.teamId,
      appIdId: flags.id,
      featureType: flags['feature-type'],
      featureValue:
        flags['feature-value'] === 'true' ? true
        : flags['feature-value'] === 'false' ? false
        : flags['feature-value'],
    }),
});
