import { Flags } from '@oclif/core';
import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'Regenerate profile',
  flags: {
    platform: Flags.string({ description: 'Developer Portal namespace.', options: ['ios', 'mac'] }),
    'app-id': Flags.string({ description: 'Opaque App ID record ID.', required: true }),
    'certificate-id': Flags.string({
      description: 'Certificate ID. Repeat for each certificate.',
      required: true,
      multiple: true,
    }),
    'device-id': Flags.string({
      description: 'Device record ID. Repeat to retain all desired devices.',
      multiple: true,
    }),
    id: Flags.string({ description: 'Opaque Apple record ID.', required: true }),
    name: Flags.string({ description: 'Resource display name.', required: true }),
    'distribution-type': Flags.string({
      description: 'distribution type',
      required: true,
      options: ['limited', 'adhoc', 'store', 'inhouse', 'direct'],
    }),
    'sub-platform': Flags.string({ description: 'Apple provisioning subplatform.' }),
    template: Flags.string({ description: 'Apple provisioning template.' }),
  },
  run: async (context, flags) =>
    apple.regenerateAppleProfile({
      relay: context.relay,
      teamId: context.team!.teamId,
      platform: flags.platform as 'ios' | 'mac' | undefined,
      profileId: flags.id,
      name: flags.name,
      appIdId: flags['app-id'],
      certificateIds: flags['certificate-id'],
      deviceIds: flags['device-id'],
      distributionType: flags['distribution-type'] as apple.RegenerateAppleProfileOptions['distributionType'],
      subPlatform: flags['sub-platform'],
      template: flags.template,
    }),
});
