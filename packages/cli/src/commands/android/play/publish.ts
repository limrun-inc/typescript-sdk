import { Flags } from '@oclif/core';
import { publishToPlaystore } from '@limrun/play-auth';
import { BaseCommand } from '../../../base-command';
import { playAccessToken, playSessionFlags } from '../../../lib/play-session';

export default class PublishPlay extends BaseCommand {
  static summary = 'Publish a signed AAB already in Limrun Asset Storage to Google Play';
  static description =
    'Requires an existing Play app and its registered upload key. Publishing replaces releases on the selected track. Production requires an explicit release status.';
  static flags = {
    ...BaseCommand.baseFlags,
    ...playSessionFlags,
    'asset-id': Flags.string({ description: 'Limrun asset ID.', exclusive: ['asset-name'] }),
    'asset-name': Flags.string({ description: 'Limrun asset name.', exclusive: ['asset-id'] }),
    'package-name': Flags.string({ description: 'Android application ID.', required: true }),
    track: Flags.string({ description: 'Play track ID.', default: 'internal' }),
    'release-status': Flags.string({
      description: 'draft saves without rollout; completed rolls out on the track.',
      options: ['draft', 'completed'],
    }),
    'organization-id': Flags.string({
      description: 'Limrun organization ID when different from the API key default.',
    }),
    'registry-endpoint': Flags.string({
      description: 'Limrun registry endpoint.',
      env: 'LIM_REGISTRY_ENDPOINT',
      default: 'https://registry.limrun.com',
    }),
  };
  async run(): Promise<void> {
    const { flags } = await this.parse(PublishPlay);
    this.setParsedFlags(flags);
    if (!flags['asset-id'] && !flags['asset-name']) this.error('Provide --asset-id or --asset-name.');
    if (flags.track === 'production' && !flags['release-status'])
      this.error('Production publishing requires --release-status.');
    const accessToken = await playAccessToken(flags);
    const result = await this.withAuth(() =>
      publishToPlaystore({
        registryApiUrl: flags['registry-endpoint'],
        token: this.client.apiKey ?? undefined,
        organizationId: flags['organization-id'],
        accessToken,
        assetId: flags['asset-id'],
        assetName: flags['asset-name'],
        packageName: flags['package-name'],
        track: flags.track,
        releaseStatus: flags['release-status'] as 'draft' | 'completed' | undefined,
      }),
    );
    this.outputJson(result);
  }
}
