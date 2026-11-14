import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  getIosInstanceClient,
  ensureDaemonSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class IosInstall extends BaseCommand {
  static aliases = ['ios:install-app'];

  static summary = 'Install an app on a running iOS instance';
  static description =
    'Install an app from a local file path, asset name, or remote URL onto a running iOS instance. Local files are uploaded to Limrun asset storage automatically before installation. Named installs add a missing asset read grant to the instance role.';

  static examples = [
    '<%= config.bin %> ios install --asset-name releases/app.zip',
    '<%= config.bin %> ios install ./MyApp.ipa',
    '<%= config.bin %> ios install https://example.com/MyApp.ipa --json',
    '<%= config.bin %> ios install ./MyApp.ipa --id <instance-ID>',
    '<%= config.bin %> ios install ./MyApp.ipa --launch-mode RelaunchIfRunning',
    '<%= config.bin %> ios install https://example.com/MyApp.ipa --md5 <hex-digest>',
  ];

  static args = {
    path_or_url: Args.string({
      description:
        'Local app path (an archive such as .ipa/.zip/.tar.gz, or an .app directory) or remote URL to an installable iOS package',
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
      description: 'iOS instance ID to install the app on. Defaults to the last created iOS instance.',
    }),
    md5: Flags.string({
      description: 'Optional MD5 digest to enable server-side install caching for remote URLs.',
    }),
    'launch-mode': Flags.string({
      description: 'Launch behavior after installation. Omit to install without launching.',
      options: ['ForegroundIfRunning', 'RelaunchIfRunning'],
    }),
    'asset-ttl': Flags.string({
      description:
        'When uploading a local file, set its asset time-to-live as a Go duration (e.g. "24h", min 1m). Defaults to no expiry.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosInstall);
    this.setParsedFlags(flags);
    if (Boolean(args.path_or_url) === Boolean(flags['asset-name'])) {
      this.error('Provide a local path or URL, or --asset-name, but not both.');
    }

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const id = resolvedInstance.id;
      if (false) {
        this.error('ios install only supports iOS instances');
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
        let uploadPath = filePath;
        let tmpDir: string | undefined;
        // Directories (e.g. .app bundles) are archived before upload; the
        // server detects the archive type from content, not the asset name,
        // so the asset keeps the original directory name.
        if (fs.statSync(filePath).isDirectory()) {
          this.info(`Archiving ${name}...`);
          tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lim-install-app-'));
          uploadPath = path.join(tmpDir, `${name}.tar.gz`);
          execFileSync('tar', ['-czf', uploadPath, '-C', path.dirname(filePath), name]);
        }
        try {
          this.info(`Uploading ${name}...`);
          const asset = await this.client.assets.getOrUpload({
            path: uploadPath,
            name,
            ttl: flags['asset-ttl'],
          });
          assetName = asset.name;
          assetId = asset.id;
        } finally {
          if (tmpDir) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
        }
      }

      let installOptions:
        | { md5?: string; launchMode?: 'ForegroundIfRunning' | 'RelaunchIfRunning' }
        | undefined;
      if (flags.md5 || flags['launch-mode']) {
        installOptions = {
          md5: flags.md5,
          launchMode: flags['launch-mode'] as 'ForegroundIfRunning' | 'RelaunchIfRunning' | undefined,
        };
      }

      if (assetName) await this.ensureInstallPermissions(id, assetName, assetId);

      if (await ensureDaemonSession(resolvedInstance)) {
        try {
          const result = await sendSessionCommand(
            id,
            assetName ? 'install-app-by-name' : 'install-app',
            [assetName ?? downloadUrl, installOptions],
            120_000,
          );
          if (flags.json) {
            this.outputJson(result);
          } else {
            this.log('App installed');
          }
          return;
        } catch (err) {
          // Older background sessions cannot dispatch named installs; connect directly instead.
          if (!assetName || !(err instanceof Error) || err.message !== 'Unknown command: install-app-by-name')
            throw err;
        }
      }

      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        const result =
          assetName ?
            await client.installAppByName(assetName, installOptions)
          : await client.installApp(downloadUrl!, installOptions);
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
