import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { parseLabels } from '../../lib/formatting';
import { registerCreatedInstance, saveInstanceCache } from '../../lib/config';
import { type IosInstanceCreateParams } from '@limrun/api/resources/ios-instances';
import { type XcodeInstanceCreateParams } from '@limrun/api/resources/xcode-instances';

function xcodeSandboxIdFromUrl(url: string): string | undefined {
  return url.match(/\/(sandbox_[^/]+)(?:\/|$)/)?.[1];
}

export default class XcodeCreate extends BaseCommand {
  static summary = 'Create a new Xcode instance';
  static description =
    'Create a new cloud Xcode sandbox for remote sync and build workflows. Use `--ios` to create an iOS instance with an attached Xcode sandbox instead of a standalone Xcode sandbox.';

  static examples = [
    '<%= config.bin %> xcode create',
    '<%= config.bin %> xcode create --ios',
    '<%= config.bin %> xcode create --rm --region us-west',
    '<%= config.bin %> xcode create --label env=dev --display-name ci-builder',
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
    region: Flags.string({ description: 'Region where the sandbox should be created, such as us-west' }),
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
    ios: Flags.boolean({
      description:
        'Create an iOS instance with an attached Xcode sandbox instead of a standalone Xcode sandbox',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(XcodeCreate);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const labels = parseLabels(flags.label);
      if (flags.ios) {
        const params: IosInstanceCreateParams = {
          wait: true,
          reuseIfExists: flags['reuse-if-exists'] || undefined,
          spec: {
            sandbox: { xcode: { enabled: true } },
          },
        };

        if (flags.region) params.spec!.region = flags.region;
        if (flags['hard-timeout']) params.spec!.hardTimeout = flags['hard-timeout'];
        if (flags['inactivity-timeout']) params.spec!.inactivityTimeout = flags['inactivity-timeout'];

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
        registerCreatedInstance(instance.metadata.id, ['xcode']);
        this.info(
          `Created a new iOS instance with Xcode sandbox in ${((Date.now() - start) / 1000).toFixed(1)}s`,
        );
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
        return;
      }

      const params: XcodeInstanceCreateParams = {
        wait: true,
        reuseIfExists: flags['reuse-if-exists'] || undefined,
        spec: {},
      };

      if (flags.region) params.spec!.region = flags.region;
      if (flags['hard-timeout']) params.spec!.hardTimeout = flags['hard-timeout'];
      if (flags['inactivity-timeout']) params.spec!.inactivityTimeout = flags['inactivity-timeout'];

      if (flags['display-name'] || labels) {
        params.metadata = {};
        if (flags['display-name']) params.metadata.displayName = flags['display-name'];
        if (labels) params.metadata.labels = labels;
      }

      const start = Date.now();
      const instance = await this.client.xcodeInstances.create(params);
      const consoleUrl = this.consoleStreamUrl(instance.metadata.id);
      registerCreatedInstance(instance.metadata.id);
      this.info(`Created a new Xcode instance in ${((Date.now() - start) / 1000).toFixed(1)}s`);
      this.info('Xcode Instance:');
      this.info(`  ID: ${instance.metadata.id}`);
      this.info(`  Console URL: ${consoleUrl}`);
      this.info(`  Region: ${instance.spec.region}`);
      this.info(`  State: ${instance.status.state}`);

      if (flags.json) {
        this.outputJson(instance);
      } else if (this.isQuietEnabled()) {
        this.output(instance.metadata.id);
      }

      if (flags.rm) {
        const cleanup = async () => {
          try {
            await this.client.xcodeInstances.delete(instance.metadata.id);
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
