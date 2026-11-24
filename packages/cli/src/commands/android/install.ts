import path from 'path';
import fs from 'fs';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  getAndroidInstanceClient,
  ensureDaemonSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class AndroidInstall extends BaseCommand {
  static aliases = ['android:install-app'];

  static summary = 'Install an app on a running Android instance';
  static description =
    'Install an app from a local file path, asset name, or remote URL onto a running Android instance. Local files are uploaded to Limrun asset storage automatically before installation. Named installs add a missing asset read grant to the instance role.';

  static examples = [
    '<%= config.bin %> android install --asset-name releases/app.apk',
    '<%= config.bin %> android install ./app.apk',
    '<%= config.bin %> android install https://example.com/app.apk --id <instance-ID>',
  ];

  static args = {
    path_or_url: Args.string({
      description: 'Local app file path or remote URL to an installable Android package such as .apk',
      required: false,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'asset-name': Flags.string({
      description: 'Install an existing asset by exact name, granting instance read permission if needed.',
      exclusive: ['asset-ttl'],
    }),
    id: Flags.string({
      description:
        'Android instance ID to install the app on. Defaults to the last created Android instance.',
    }),
    'asset-ttl': Flags.string({
      description:
        'When uploading a local file, set its asset time-to-live as a Go duration (e.g. "24h", min 1m). Defaults to no expiry.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AndroidInstall);
    this.setParsedFlags(flags);
    if (Boolean(args.path_or_url) === Boolean(flags['asset-name'])) {
      this.error('Provide a local path or URL, or --asset-name, but not both.');
    }

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveAndroidInstance(flags.id);
      const id = resolvedInstance.id;
      if (false) {
        this.error('android install only supports Android instances');
      }

      let downloadUrl: string | undefined;
      let assetName = flags['asset-name'];
      let assetId: string | undefined;
      const source = args.path_or_url;
      if (source?.startsWith('http://') || source?.startsWith('https://')) {
        downloadUrl = source;
      } else if (source) {
        const filePath = path.resolve(source);
        if (!fs.existsSync(filePath)) {
          this.error(`File not found: ${filePath}`);
        }
        const name = path.basename(filePath);
        this.info(`Uploading ${name}...`);
        const asset = await this.client.assets.getOrUpload({ path: filePath, name, ttl: flags['asset-ttl'] });
        assetName = asset.name;
        assetId = asset.id;
      }

      if (assetName) await this.ensureInstallPermissions(id, assetName, assetId);

      if (await ensureDaemonSession(resolvedInstance)) {
        try {
          await sendSessionCommand(
            id,
            assetName ? 'install-app-by-name' : 'install-app',
            [assetName ?? downloadUrl],
            120_000,
          );
          this.outputResult(
            { ok: true, instanceId: id, source: args.path_or_url ?? assetName, assetId },
            'App sent to instance',
          );
          return;
        } catch (err) {
          // Older background sessions cannot dispatch named installs; connect directly instead.
          if (!assetName || !(err instanceof Error) || err.message !== 'Unknown command: install-app-by-name')
            throw err;
        }
      }

      const { client, disconnect } = await getAndroidInstanceClient(this.client, resolvedInstance);
      try {
        if (assetName) await client.installAppByName(assetName);
        else await client.sendAsset(downloadUrl!);
        this.outputResult(
          { ok: true, instanceId: id, source: args.path_or_url ?? assetName, assetId },
          'App sent to instance',
        );
      } finally {
        disconnect();
      }
    });
  }
}
