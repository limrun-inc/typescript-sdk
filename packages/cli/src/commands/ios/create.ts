import path from 'path';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { parseLabels } from '../../lib/formatting';
import { saveInstanceCache, saveLastInstanceId } from '../../lib/config';
import { type IosInstanceCreateParams } from '@limrun/api/resources/ios-instances';

function xcodeSandboxIdFromUrl(url: string): string | undefined {
  return url.match(/\/(sandbox_[^/]+)(?:\/|$)/)?.[1];
}

export default class IosCreate extends BaseCommand {
  static summary = 'Create a new iOS instance';
  static description =
    'Create a new cloud iOS simulator instance and wait for it to become ready. You can attach labels, install apps, choose a device model, and optionally enable an Xcode sandbox.';

  static examples = [
    '<%= config.bin %> ios create',
    '<%= config.bin %> ios create --rm --model ipad',
    '<%= config.bin %> ios create --region us-west --install-asset my-app.ipa',
    '<%= config.bin %> ios create --install ./MyApp.ipa --xcode',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    rm: Flags.boolean({
      description: 'Delete the instance automatically when this CLI process exits',
      default: false,
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
    model: Flags.string({
      description: 'Device model to create',
      options: ['iphone', 'ipad', 'watch'],
    }),
    'reuse-if-exists': Flags.boolean({
      description: 'Reuse an existing matching instance instead of creating a new one',
      default: false,
    }),
    'install-asset': Flags.string({
      description: 'Existing asset name to install onto the instance after creation',
      multiple: true,
    }),
    install: Flags.string({
      description:
        'Local app file to upload and install automatically after creation. Repeat for multiple files.',
      multiple: true,
    }),
    xcode: Flags.boolean({
      description: 'Enable an attached Xcode sandbox for build and sync workflows',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosCreate);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      // Upload local files first
      const assetNames: string[] = [...(flags['install-asset'] || [])];
      if (flags.install) {
        for (const filePath of flags.install) {
          const resolved = path.resolve(filePath);
          const name = path.basename(resolved);
          this.info(`Uploading ${name}...`);
          const asset = await this.client.assets.getOrUpload({ path: resolved, name });
          assetNames.push(asset.name);
        }
        this.info(`Successfully uploaded ${flags.install.length} file(s)`);
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
      if (flags.xcode) {
        params.spec!.sandbox = { xcode: { enabled: true } };
      }

      const labels = parseLabels(flags.label);
      if (flags['display-name'] || labels) {
        params.metadata = {};
        if (flags['display-name']) params.metadata.displayName = flags['display-name'];
        if (labels) params.metadata.labels = labels;
      }

      const start = Date.now();
      const instance = await this.client.iosInstances.create(params);
      const consoleUrl = this.consoleStreamUrl(instance.metadata.id);
      const xcodeSandboxUrl = instance.status.sandbox?.xcode?.url;
      const xcodeSandboxId = xcodeSandboxUrl ? xcodeSandboxIdFromUrl(xcodeSandboxUrl) : undefined;
      saveLastInstanceId(instance.metadata.id);
      this.info(`Created a new iOS instance in ${((Date.now() - start) / 1000).toFixed(1)}s`);
      this.info('iOS Instance:');
      this.info(`  ID: ${instance.metadata.id}`);
      this.info(`  Console URL: ${consoleUrl}`);
      this.info(`  Region: ${instance.spec.region}`);
      this.info(`  State: ${instance.status.state}`);
      if (xcodeSandboxUrl) {
        this.info('Xcode Sandbox:');
        if (xcodeSandboxId) {
          this.info(`  ID: ${xcodeSandboxId}`);
        }
        this.info(`  URL: ${xcodeSandboxUrl}`);
        saveInstanceCache(instance.metadata.id, {
          sandboxXcodeUrl: xcodeSandboxUrl,
          token: instance.status.token,
        });
      }

      if (flags.json) {
        this.outputJson(instance);
      } else if (this.isQuietEnabled()) {
        this.output(instance.metadata.id);
      }

      if (flags.rm) {
        const cleanup = async () => {
          try {
            await this.client.iosInstances.delete(instance.metadata.id);
            this.info(`${instance.metadata.id} is deleted`);
          } catch (e) {
            this.info(`Failed to delete instance: ${e}`);
          }
        };

        this.info('Instance running. Press Ctrl+C to stop and delete.');
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
