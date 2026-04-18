import path from 'path';
import fs from 'fs';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  detectInstanceType,
  getInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class AndroidInstallApp extends BaseCommand {
  static summary = 'Install an app on a running Android instance';
  static description =
    'Install an app from a local file path or remote URL onto a running Android instance. Local files are uploaded to Limrun asset storage automatically before installation.';

  static examples = [
    '<%= config.bin %> android install-app ./app.apk',
    '<%= config.bin %> android install-app https://example.com/app.apk --id <instance-ID>',
  ];

  static args = {
    path_or_url: Args.string({
      description: 'Local app file path or remote URL to an installable Android package such as .apk',
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description:
        'Android instance ID to install the app on. Defaults to the last created Android instance.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AndroidInstallApp);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (detectInstanceType(id) !== 'android') {
        this.error('android install-app only supports Android instances');
      }

      let downloadUrl: string;
      if (args.path_or_url.startsWith('http://') || args.path_or_url.startsWith('https://')) {
        downloadUrl = args.path_or_url;
      } else {
        const filePath = path.resolve(args.path_or_url);
        if (!fs.existsSync(filePath)) {
          this.error(`File not found: ${filePath}`);
        }
        const name = path.basename(filePath);
        this.info(`Uploading ${name}...`);
        const asset = await this.client.assets.getOrUpload({ path: filePath, name });
        downloadUrl = asset.signedDownloadUrl;
      }

      if (hasActiveSession(id)) {
        await sendSessionCommand(id, 'install-app', [downloadUrl]);
        this.log('App sent to instance');
        return;
      }

      const { type, client, disconnect } = await getInstanceClient(this.client, id);
      try {
        if (type !== 'android') {
          this.error('android install-app only supports Android instances');
        }
        await (client as any).sendAsset(downloadUrl);
        this.log('App sent to instance');
      } finally {
        disconnect();
      }
    });
  }
}
