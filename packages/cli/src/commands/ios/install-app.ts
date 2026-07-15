import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  getIosInstanceClient,
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
    '<%= config.bin %> ios install-app ./MyApp.ipa --launch-mode RelaunchIfRunning',
    '<%= config.bin %> ios install-app https://example.com/MyApp.ipa --md5 <hex-digest>',
  ];

  static args = {
    path_or_url: Args.string({
      description:
        'Local app path (an archive such as .ipa/.zip/.tar.gz, or an .app directory) or remote URL to an installable iOS package',
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
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
    const { args, flags } = await this.parse(IosInstallApp);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const id = resolvedInstance.id;
      if (false) {
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
          downloadUrl = asset.signedDownloadUrl;
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

      if (hasActiveSession(id)) {
        const result = await sendSessionCommand(id, 'install-app', [downloadUrl, installOptions]);
        if (flags.json) {
          this.outputJson(result);
        } else {
          this.log('App installed');
        }
        return;
      }

      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        const result = await client.installApp(downloadUrl, installOptions);
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
