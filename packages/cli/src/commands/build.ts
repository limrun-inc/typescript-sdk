import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../base-command';
import { detectInstanceType } from '../lib/instance-client-factory';
import { loadInstanceCache } from '../lib/config';

export default class Build extends BaseCommand {
  static summary = 'Run xcodebuild on a Xcode sandbox';
  static aliases = ['ios build', 'xcode build'];
  static description =
    'Triggers a remote xcodebuild with streaming output. ' +
    'Works with both standalone Xcode instances and iOS instances that have --xcode enabled.';

  static examples = [
    '<%= config.bin %> build <xcode-instance-ID>',
    '<%= config.bin %> build <ios-instance-ID> --scheme MyApp',
    '<%= config.bin %> build <xcode-instance-ID> --scheme MyApp --workspace MyApp.xcworkspace',
  ];

  static args = {
    id: Args.string({ description: 'Xcode or iOS instance ID', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    scheme: Flags.string({ description: 'Xcode scheme' }),
    workspace: Flags.string({ description: 'Xcode workspace file' }),
    project: Flags.string({ description: 'Xcode project file' }),
    upload: Flags.string({ description: 'Upload build artifact as asset with this name' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Build);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const xcodeClient = await this.resolveXcodeClientFromIosInstance(args.id);

      const settings: Record<string, string> = {};
      if (flags.scheme) settings.scheme = flags.scheme;
      if (flags.workspace) settings.workspace = flags.workspace;
      if (flags.project) settings.project = flags.project;

      const options: Record<string, unknown> = {};
      if (flags.upload) {
        options.upload = { assetName: flags.upload };
      }

      this.log('Starting xcodebuild...');

      const proc = xcodeClient.xcodebuild(
        Object.keys(settings).length > 0 ? settings : undefined,
        Object.keys(options).length > 0 ? options : undefined,
      );

      proc.stdout.on('data', (chunk: string) => {
        process.stdout.write(chunk);
      });

      proc.stderr.on('data', (chunk: string) => {
        process.stderr.write(chunk);
      });

      const result = await proc;

      if (result.exitCode !== 0) {
        this.error(`xcodebuild failed with exit code ${result.exitCode}`, { exit: result.exitCode });
      }

      this.log(`\nBuild succeeded (exit code ${result.exitCode})`);
    });
  }

  private async resolveXcodeClientFromIosInstance(id: string) {
    const type = detectInstanceType(id).toString();

    if (type === 'ios') {
      const instance = await this.client.iosInstances.get(id);
      let sandboxUrl = instance.status.sandbox?.xcode?.url;
      let token = instance.status.token;

      if (!sandboxUrl) {
        const cached = loadInstanceCache(id);
        if (cached?.sandboxXcodeUrl) {
          sandboxUrl = cached.sandboxXcodeUrl;
          token = cached.token || token;
        }
      }

      if (!sandboxUrl) {
        this.error(`iOS instance ${id} does not have a Xcode sandbox. Create it with: lim run ios --xcode`);
      }
      return this.client.xcodeInstances.createClient({
        apiUrl: sandboxUrl,
        token,
      });
    }

    const instance = await this.client.xcodeInstances.get(id);
    return this.client.xcodeInstances.createClient({ instance });
  }
}
