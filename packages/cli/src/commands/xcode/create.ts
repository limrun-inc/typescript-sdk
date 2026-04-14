import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { parseLabels } from '../../lib/formatting';
import { saveLastInstanceId } from '../../lib/config';
import { type XcodeInstanceCreateParams } from '@limrun/api/resources/xcode-instances';

export default class XcodeCreate extends BaseCommand {
  static summary = 'Create a new Xcode instance';
  static description = 'Creates a new Xcode build sandbox instance in the cloud.';
  static aliases = ['run xcode'];

  static examples = [
    '<%= config.bin %> xcode create',
    '<%= config.bin %> xcode create --rm --region us-west',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    rm: Flags.boolean({ description: 'Delete instance on exit', default: false }),
    'display-name': Flags.string({ description: 'Display name for the instance' }),
    region: Flags.string({ description: 'Region where the instance will be created' }),
    'hard-timeout': Flags.string({ description: 'Hard timeout (e.g. 1m, 10m, 3h). Default: no timeout' }),
    'inactivity-timeout': Flags.string({ description: 'Inactivity timeout (e.g. 1m, 10m, 3h). Default: 3m' }),
    label: Flags.string({ description: 'Labels in key=value format', multiple: true }),
    'reuse-if-exists': Flags.boolean({
      description: 'Reuse existing instance with same labels/region',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(XcodeCreate);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const params: XcodeInstanceCreateParams = {
        wait: true,
        reuseIfExists: flags['reuse-if-exists'] || undefined,
        spec: {},
      };

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
      const instance = await this.client.xcodeInstances.create(params);
      saveLastInstanceId(instance.metadata.id);
      this.log(`Created a new Xcode instance in ${((Date.now() - start) / 1000).toFixed(1)}s`);
      this.log(`Instance ID: ${instance.metadata.id}`);
      this.log(`Region: ${instance.spec.region}`);
      this.log(`State: ${instance.status.state}`);

      if (flags.json) {
        this.outputJson(instance);
      }

      if (flags.rm) {
        const cleanup = async () => {
          try {
            await this.client.xcodeInstances.delete(instance.metadata.id);
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
