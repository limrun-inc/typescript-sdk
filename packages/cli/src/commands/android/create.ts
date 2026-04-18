import path from 'path';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { parseLabels } from '../../lib/formatting';
import { saveLastInstanceId } from '../../lib/config';
import { type AndroidInstanceCreateParams } from '@limrun/api/resources/android-instances';

export default class AndroidCreate extends BaseCommand {
  static summary = 'Create a new Android instance';
  static description =
    'Create a new cloud Android instance and optionally connect to it immediately with an ADB tunnel. Use the printed Console URL to open the live device stream in your browser.';

  static examples = [
    '<%= config.bin %> android create',
    '<%= config.bin %> android create --rm --install ./app.apk',
    '<%= config.bin %> android create --region us-west --label env=dev',
    '<%= config.bin %> android create --no-connect',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    connect: Flags.boolean({
      description: 'Connect to the new instance immediately by starting an ADB tunnel',
      default: true,
      allowNo: true,
    }),
    rm: Flags.boolean({
      description: 'Delete the instance automatically when this CLI process exits',
      default: false,
    }),
    'adb-path': Flags.string({
      description: 'Path to the adb binary used for tunnel-driven workflows',
      default: 'adb',
    }),
    'display-name': Flags.string({
      description: 'Human-friendly display name shown in listings and the console',
    }),
    region: Flags.string({ description: 'Region where the instance should be created, such as us-west' }),
    'hard-timeout': Flags.string({ description: 'Hard timeout (e.g. 1m, 10m, 3h). Default: no timeout' }),
    'inactivity-timeout': Flags.string({ description: 'Inactivity timeout (e.g. 1m, 10m, 3h). Default: 3m' }),
    label: Flags.string({
      description: 'Metadata label in key=value format. Repeat to attach multiple labels.',
      multiple: true,
    }),
    'reuse-if-exists': Flags.boolean({
      description: 'Reuse an existing matching instance instead of creating a new one',
      default: false,
    }),
    'install-asset': Flags.string({
      description: 'Existing asset name to install after creation. Repeat for multiple assets.',
      multiple: true,
    }),
    install: Flags.string({
      description:
        'Local app file to upload and install automatically after creation. Repeat for multiple files.',
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
      saveLastInstanceId(instance.metadata.id);
      this.log(`Created a new instance in ${((Date.now() - start) / 1000).toFixed(1)}s`);
      this.log(`Instance ID: ${instance.metadata.id}`);
      this.log(`Console URL: ${this.consoleStreamUrl(instance.metadata.id)}`);

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
        this.log(
          `Open the Console URL in your browser to stream the device: ${this.consoleStreamUrl(
            instance.metadata.id,
          )}`,
        );
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
