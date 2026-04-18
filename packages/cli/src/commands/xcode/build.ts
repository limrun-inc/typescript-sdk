import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { detectInstanceType } from '../../lib/instance-client-factory';
import { loadInstanceCache } from '../../lib/config';
import { compileIgnorePatterns } from '../../lib/ignore-patterns';

export default class XcodeBuild extends BaseCommand {
  static summary = 'Run xcodebuild on an Xcode sandbox';
  static description =
    'Sync a local project path once (or the current working directory if omitted), then trigger a remote xcodebuild with streaming output. This works with standalone Xcode instances and can also target an iOS instance with `--xcode` enabled when you pass `--id`.';

  static examples = [
    '<%= config.bin %> xcode build',
    '<%= config.bin %> xcode build ./MyProject',
    '<%= config.bin %> xcode build --id <xcode-instance-ID>',
    '<%= config.bin %> xcode build ./MyProject --id <xcode-instance-ID>',
    '<%= config.bin %> xcode build --scheme MyApp --workspace MyApp.xcworkspace',
    '<%= config.bin %> xcode build --id <ios-instance-ID> --project MyApp.xcodeproj --upload ios-build.zip',
    '<%= config.bin %> xcode build ./MyProject --basis-cache-dir ./.limsync-cache --max-patch-bytes 2097152',
    '<%= config.bin %> xcode build ./MyProject --ignore "\\\\.xcuserdata/"',
  ];

  static args = {
    path: Args.string({
      description: 'Local project path to sync before building. Defaults to the current working directory.',
      required: false,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description:
        'Xcode instance ID to build on, or an iOS instance ID with `--xcode` enabled. Defaults to the last created Xcode instance.',
    }),
    scheme: Flags.string({ description: 'Xcode scheme to build, such as MyApp' }),
    workspace: Flags.string({
      description: 'Workspace file to pass to xcodebuild, such as MyApp.xcworkspace',
    }),
    project: Flags.string({ description: 'Project file to pass to xcodebuild, such as MyApp.xcodeproj' }),
    upload: Flags.string({ description: 'Upload the resulting build artifact as an asset with this name' }),
    'basis-cache-dir': Flags.string({
      description: 'Directory to use for the client-side delta sync cache during the pre-build sync step.',
    }),
    'max-patch-bytes': Flags.integer({
      description: 'Maximum patch size in bytes before falling back to a full upload during sync.',
    }),
    ignore: Flags.string({
      description:
        'Regular expression to ignore matching relative paths during the pre-build sync. Repeat for multiple patterns.',
      multiple: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(XcodeBuild);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      const syncPath = args.path ?? process.cwd();
      const xcodeClient = await this.resolveXcodeClientFromIosInstance(id);

      const settings: Record<string, string> = {};
      if (flags.scheme) settings.scheme = flags.scheme;
      if (flags.workspace) settings.workspace = flags.workspace;
      if (flags.project) settings.project = flags.project;

      const options: Record<string, unknown> = {};
      if (flags.upload) {
        options.upload = { assetName: flags.upload };
      }

      this.info(`Syncing ${syncPath} to instance ${id}...`);
      await xcodeClient.sync(syncPath, {
        watch: false,
        install: false,
        basisCacheDir: flags['basis-cache-dir'],
        maxPatchBytes: flags['max-patch-bytes'],
        ignore: compileIgnorePatterns(flags.ignore),
      });
      this.info('Sync complete.');

      this.info('Starting xcodebuild...');

      const proc = xcodeClient.xcodebuild(
        Object.keys(settings).length > 0 ? settings : undefined,
        Object.keys(options).length > 0 ? options : undefined,
      );

      proc.stdout.on('data', (line: string) => {
        process.stdout.write(line + '\n');
      });

      proc.stderr.on('data', (line: string) => {
        process.stderr.write(line + '\n');
      });

      const result = await proc;

      if (result.exitCode !== 0) {
        this.error(`xcodebuild failed with exit code ${result.exitCode}`, { exit: result.exitCode });
      }

      this.output(`\nBuild succeeded (exit code ${result.exitCode})`);
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
        this.error(
          `iOS instance ${id} does not have a Xcode sandbox. Create it with: lim ios create --xcode`,
        );
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
