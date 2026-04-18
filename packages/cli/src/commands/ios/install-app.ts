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

export default class IosInstallApp extends BaseCommand {
  static summary = 'Install an app on a running iOS instance';
  static description =
    'Install an app from a local file path or remote URL onto a running iOS instance. Local files are uploaded to Limrun asset storage automatically before installation.';

  static examples = [
    '<%= config.bin %> ios install-app ./MyApp.ipa',
    '<%= config.bin %> ios install-app https://example.com/MyApp.ipa --json',
    '<%= config.bin %> ios install-app ./MyApp.ipa --id <instance-ID>',
  ];

  static args = {
    path_or_url: Args.string({
      description: 'Local app file path or remote URL to an installable iOS package such as .ipa',
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to install the app on. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosInstallApp);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (detectInstanceType(id) !== 'ios') {
        this.error('ios install-app only supports iOS instances');
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
        const result = await sendSessionCommand(id, 'install-app', [downloadUrl]);
        if (flags.json) {
          this.outputJson(result);
        } else {
          this.log('App installed');
        }
        return;
      }

      const { type, client, disconnect } = await getInstanceClient(this.client, id);
      try {
        if (type !== 'ios') {
          this.error('ios install-app only supports iOS instances');
        }
        const result = await (client as any).installApp(downloadUrl);
        if (flags.json) {
          this.outputJson(result);
        } else {
          this.log(`App installed${result?.bundleId ? `: ${result.bundleId}` : ''}`);
        }
      } finally {
        disconnect();
      }
    });
  }
}
