import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../base-command';

export default class Build extends BaseCommand {
  static summary = 'Run xcodebuild on a Xcode instance';
  static description = 'Triggers a remote xcodebuild with streaming output.';

  static examples = [
    '<%= config.bin %> build <xcode-instance-ID>',
    '<%= config.bin %> build <xcode-instance-ID> --scheme MyApp --workspace MyApp.xcworkspace',
  ];

  static args = {
    id: Args.string({ description: 'Xcode instance ID', required: true }),
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
      const instance = await this.client.xcodeInstances.get(args.id);
      const xcodeClient = await this.client.xcodeInstances.createClient({ instance });

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
}
