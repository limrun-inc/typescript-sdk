import path from 'path';
import fs from 'fs';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendSessionCommand } from '../../lib/instance-client-factory';

export default class ExecInstallApp extends BaseCommand {
  static summary = 'Install an app on a running instance';
  static description =
    'Installs an app from a local file or URL. Local files are auto-uploaded to asset storage first.';
  static aliases = ['ios install-app', 'android install-app'];

  static examples = [
    '<%= config.bin %> ios install-app ./MyApp.ipa',
    '<%= config.bin %> android install-app ./app.apk --id <instance-ID>',
  ];

  static args = {
    path_or_url: Args.string({ description: 'Local file path or URL', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'Instance ID (defaults to last created)' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ExecInstallApp);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      let downloadUrl: string;

      if (args.path_or_url.startsWith('http://') || args.path_or_url.startsWith('https://')) {
        downloadUrl = args.path_or_url;
      } else {
        const filePath = path.resolve(args.path_or_url);
        if (!fs.existsSync(filePath)) {
          this.error(`File not found: ${filePath}`);
        }
        const name = path.basename(filePath);
        this.log(`Uploading ${name}...`);
        const asset = await this.client.assets.getOrUpload({ path: filePath, name });
        downloadUrl = asset.signedDownloadUrl;
      }

      if (hasActiveSession(id)) {
        const result = await sendSessionCommand(id, 'install-app', [downloadUrl]);
        if (flags.json) {
          this.outputJson(result);
        } else {
          this.log('App installed');
        }
      } else {
        const { type, client, disconnect } = await getInstanceClient(this.client, id);
        try {
          if (type === 'ios') {
            const result = await (client as any).installApp(downloadUrl);
            if (flags.json) {
              this.outputJson(result);
            } else {
              this.log(`App installed${result?.bundleId ? `: ${result.bundleId}` : ''}`);
            }
          } else {
            await (client as any).sendAsset(downloadUrl);
            this.log('App sent to instance');
          }
        } finally {
          disconnect();
        }
      }
    });
  }
}
