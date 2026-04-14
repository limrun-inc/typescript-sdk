import path from 'path';
import { spawn } from 'child_process';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { parseLabels } from '../../lib/formatting';
import { type AndroidInstanceCreateParams } from '@limrun/api/resources/android-instances';

export default class AndroidCreate extends BaseCommand {
  static summary = 'Create a new Android instance';
  static description =
    'Creates and optionally connects to a new Android instance with ADB tunnel and scrcpy streaming.';
  static aliases = ['run android'];

  static examples = [
    '<%= config.bin %> android create',
    '<%= config.bin %> android create --rm --install ./app.apk',
    '<%= config.bin %> android create --region us-west --label env=dev',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    connect: Flags.boolean({
      description: 'Connect to the instance (start ADB tunnel)',
      default: true,
      allowNo: true,
    }),
    stream: Flags.boolean({ description: 'Stream the instance with scrcpy', default: true, allowNo: true }),
    rm: Flags.boolean({ description: 'Delete instance on exit', default: false }),
    'adb-path': Flags.string({ description: 'Path to adb binary', default: 'adb' }),
    'display-name': Flags.string({ description: 'Display name for the instance' }),
    region: Flags.string({ description: 'Region where the instance will be created' }),
    'hard-timeout': Flags.string({ description: 'Hard timeout (e.g. 1m, 10m, 3h). Default: no timeout' }),
    'inactivity-timeout': Flags.string({ description: 'Inactivity timeout (e.g. 1m, 10m, 3h). Default: 3m' }),
    label: Flags.string({ description: 'Labels in key=value format', multiple: true }),
    'reuse-if-exists': Flags.boolean({
      description: 'Reuse existing instance with same labels/region',
      default: false,
    }),
    'install-asset': Flags.string({ description: 'Asset name to install (can be repeated)', multiple: true }),
    install: Flags.string({
      description: 'Local file to install (auto-uploads if needed, can be repeated)',
      multiple: true,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AndroidCreate);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      // Upload local files first
      const assetNames: string[] = [...(flags['install-asset'] || [])];
      if (flags.install) {
        for (const filePath of flags.install) {
          const resolved = path.resolve(filePath);
          const name = path.basename(resolved);
          this.log(`Uploading ${name}...`);
          const asset = await this.client.assets.getOrUpload({ path: resolved, name });
          assetNames.push(asset.name);
        }
        this.log(`Successfully uploaded ${flags.install.length} file(s)`);
      }

      // Build params
      const params: AndroidInstanceCreateParams = {
        wait: true,
        reuseIfExists: flags['reuse-if-exists'] || undefined,
        spec: {},
      };

      if (assetNames.length > 0) {
        params.spec!.initialAssets = assetNames.map((name) => ({
          kind: 'App' as const,
          source: 'AssetName' as const,
          assetName: name,
        }));
      }

      if (flags.region) params.spec!.region = flags.region;
      if (flags['hard-timeout']) params.spec!.hardTimeout = flags['hard-timeout'];
      if (flags['inactivity-timeout']) params.spec!.inactivityTimeout = flags['inactivity-timeout'];

      const labels = parseLabels(flags.label);
      if (flags['display-name'] || labels) {
        params.metadata = {};
        if (flags['display-name']) params.metadata.displayName = flags['display-name'];
        if (labels) params.metadata.labels = labels;
      }

      const start = Date.now();
      const instance = await this.client.androidInstances.create(params);
      this.log(`Created a new instance in ${((Date.now() - start) / 1000).toFixed(1)}s`);

      if (flags.rm) {
        const cleanup = async () => {
          try {
            await this.client.androidInstances.delete(instance.metadata.id);
            this.log(`${instance.metadata.id} is deleted`);
          } catch (e) {
            this.log(`Failed to delete instance: ${e}`);
          }
        };
        process.on('SIGINT', async () => {
          await cleanup();
          process.exit(0);
        });
        process.on('SIGTERM', async () => {
          await cleanup();
          process.exit(0);
        });
      }

      if (flags.connect) {
        const { createInstanceClient } = await import('@limrun/api');
        const instanceClient = await createInstanceClient({
          apiUrl: instance.status.apiUrl!,
          adbUrl: instance.status.adbWebSocketUrl,
          token: instance.status.token,
        });

        const tunnel = await instanceClient.startAdbTunnel();

        if (flags.stream) {
          const addr = `${tunnel.address.address}:${tunnel.address.port}`;
          const scrcpy = spawn('scrcpy', ['-s', addr], { stdio: 'inherit' });
          scrcpy.on('error', (err) => {
            this.warn(`Failed to start scrcpy: ${err.message}`);
          });
          scrcpy.on('close', () => {
            process.kill(process.pid, 'SIGTERM');
          });
        }

        this.log('Tunnel started. Press Ctrl+C to stop.');
        await new Promise<void>((resolve) => {
          const keepAlive = setInterval(() => {}, 1 << 30);
          const shutdown = () => {
            clearInterval(keepAlive);
            resolve();
          };
          process.on('SIGINT', shutdown);
          process.on('SIGTERM', shutdown);
        });

        tunnel.close();
        instanceClient.disconnect();
      } else {
        this.log(`Created instance ${instance.metadata.id}`);
        if (flags.json) {
          this.outputJson(instance);
        }
      }
    });
  }
}
