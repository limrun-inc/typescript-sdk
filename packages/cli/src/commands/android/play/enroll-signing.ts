import { Flags } from '@oclif/core';
import { enrollPlayAppSigning } from '@limrun/play-auth';
import { BaseCommand } from '../../../base-command';
import { playAccessToken, playSessionFlags } from '../../../lib/play-session';

export default class EnrollPlaySigning extends BaseCommand {
  static summary = 'Enroll a new Play app in Google-managed distribution signing';
  static description =
    'Experimental: requires a Google-approved Console OAuth scope. Create the app in Play Console first, then use its numeric app ID, not the package name. Does not generate the upload key or publish a release.';
  static flags = {
    ...BaseCommand.baseFlags,
    ...playSessionFlags,
    'developer-id': Flags.string({ description: 'Numeric Play developer account ID.', required: true }),
    'app-id': Flags.string({ description: 'Numeric Play app ID.', required: true }),
  };
  async run(): Promise<void> {
    const { flags } = await this.parse(EnrollPlaySigning);
    this.setParsedFlags(flags);
    await enrollPlayAppSigning({
      accessToken: await playAccessToken(flags),
      developerId: flags['developer-id'],
      appId: flags['app-id'],
    });
    this.outputJson({ ok: true, developerId: flags['developer-id'], appId: flags['app-id'] });
  }
}
