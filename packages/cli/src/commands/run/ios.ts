import path from 'path';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { parseLabels } from '../../lib/formatting';
import { type IosInstanceCreateParams } from '@limrun/api/resources/ios-instances';

export default class RunIos extends BaseCommand {
  static summary = 'Create a new iOS instance';
  static description = 'Creates a new iOS simulator instance in the cloud.';

  static examples = [
    '<%= config.bin %> run ios',
    '<%= config.bin %> run ios --rm --model ipad',
    '<%= config.bin %> run ios --region us-west --install-asset my-app.ipa',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    rm: Flags.boolean({ description: 'Delete instance on exit', default: false }),
    'display-name': Flags.string({ description: 'Display name for the instance' }),
    region: Flags.string({ description: 'Region where the instance will be created' }),
    'hard-timeout': Flags.string({ description: 'Hard timeout (e.g. 1m, 10m, 3h). Default: no timeout' }),
    'inactivity-timeout': Flags.string({ description: 'Inactivity timeout (e.g. 1m, 10m, 3h). Default: 3m' }),
    label: Flags.string({ description: 'Labels in key=value format', multiple: true }),
    model: Flags.string({ description: 'Device model (iphone, ipad, watch)', options: ['iphone', 'ipad', 'watch'] }),
    'reuse-if-exists': Flags.boolean({ description: 'Reuse existing instance with same labels/region', default: false }),
    'install-asset': Flags.string({ description: 'Asset name to install', multiple: true }),
    install: Flags.string({ description: 'Local file to install (auto-uploads if needed)', multiple: true }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(RunIos);
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
      const params: IosInstanceCreateParams = {
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
      if (flags.model) params.spec!.model = flags.model as 'iphone' | 'ipad' | 'watch';
      if (flags['hard-timeout']) params.spec!.hardTimeout = flags['hard-timeout'];
      if (flags['inactivity-timeout']) params.spec!.inactivityTimeout = flags['inactivity-timeout'];

      const labels = parseLabels(flags.label);
      if (flags['display-name'] || labels) {
        params.metadata = {};
        if (flags['display-name']) params.metadata.displayName = flags['display-name'];
        if (labels) params.metadata.labels = labels;
      }

      const start = Date.now();
      const instance = await this.client.iosInstances.create(params);
      this.log(`Created a new iOS instance in ${((Date.now() - start) / 1000).toFixed(1)}s`);
      this.log(`Instance ID: ${instance.metadata.id}`);
      this.log(`Region: ${instance.spec.region}`);
      this.log(`State: ${instance.status.state}`);

      if (flags.json) {
        this.outputJson(instance);
      }

      if (flags.rm) {
        const cleanup = async () => {
          try {
            await this.client.iosInstances.delete(instance.metadata.id);
            this.log(`${instance.metadata.id} is deleted`);
          } catch (e) {
            this.log(`Failed to delete instance: ${e}`);
          }
        };

        this.log('Instance running. Press Ctrl+C to stop and delete.');
        await new Promise<void>((resolve) => {
          const keepAlive = setInterval(() => {}, 1 << 30);
          const shutdown = () => {
            clearInterval(keepAlive);
            resolve();
          };
          process.on('SIGINT', shutdown);
          process.on('SIGTERM', shutdown);
        });
        await cleanup();
      }
    });
  }
}
