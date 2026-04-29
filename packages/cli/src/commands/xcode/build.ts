import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { compileIgnorePatterns } from '../../lib/ignore-patterns';
import { formatDurationMs } from '../../lib/duration';
import { parseAdditionalFileFlags } from '../../lib/additional-files';

export default class XcodeBuild extends BaseCommand {
  static summary = 'Run xcodebuild on an Xcode sandbox';
  static description =
    'Sync a local project path once (or the current working directory if omitted), then trigger a remote xcodebuild with streaming output. This works with standalone Xcode instances and can also target an iOS instance with `--xcode` enabled or created via `xcode create --ios` when you pass `--id`.';

  static examples = [
    '<%= config.bin %> xcode build',
    '<%= config.bin %> xcode build ./MyProject',
    '<%= config.bin %> xcode build --id <xcode-instance-ID>',
    '<%= config.bin %> xcode build ./MyProject --id <xcode-instance-ID>',
    '<%= config.bin %> xcode build --scheme MyApp --workspace MyApp.xcworkspace',
    '<%= config.bin %> xcode build --scheme WatchApp --sdk watchsimulator',
    '<%= config.bin %> xcode build --id <ios-instance-ID> --project MyApp.xcodeproj --upload ios-build.zip',
    '<%= config.bin %> xcode build --signed-upload-url <url>',
    '<%= config.bin %> xcode build ./MyProject --basis-cache-dir ./.limsync-cache --max-patch-bytes 2097152',
    '<%= config.bin %> xcode build ./MyProject --ignore "\\\\.xcuserdata/"',
    '<%= config.bin %> xcode build ./MyProject --additional-file ~/.netrc=~/.netrc',
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
        'Xcode instance ID to build on, or an iOS instance ID with `--xcode` enabled. Defaults to the most recently created Xcode-capable target.',
    }),
    scheme: Flags.string({ description: 'Xcode scheme to build, such as MyApp' }),
    workspace: Flags.string({
      description: 'Workspace file to pass to xcodebuild, such as MyApp.xcworkspace',
    }),
    project: Flags.string({ description: 'Project file to pass to xcodebuild, such as MyApp.xcodeproj' }),
    sdk: Flags.string({
      description: 'SDK family to build for.',
      options: ['iphonesimulator', 'iphoneos', 'watchsimulator', 'watchos'],
    }),
    upload: Flags.string({ description: 'Upload the resulting build artifact as an asset with this name' }),
    'signed-upload-url': Flags.string({
      description: 'Presigned URL to upload the resulting build artifact to.',
    }),
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
    'additional-file': Flags.string({
      description:
        'Additional file to sync before building as localPath=remotePath, for example ~/.netrc=~/.netrc. Repeat for multiple files.',
      multiple: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(XcodeBuild);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      const syncPath = args.path ?? process.cwd();
      const xcodeClient = await this.resolveXcodeClient(id);

      const settings: Record<string, string> = {};
      if (flags.scheme) settings.scheme = flags.scheme;
      if (flags.workspace) settings.workspace = flags.workspace;
      if (flags.project) settings.project = flags.project;
      if (flags.sdk) settings.sdk = flags.sdk;

      const options: Record<string, unknown> = {};
      if (flags.upload && flags['signed-upload-url']) {
        this.error('Use either --upload or --signed-upload-url, not both.');
      }
      if (flags.upload) {
        options.upload = { assetName: flags.upload };
      } else if (flags['signed-upload-url']) {
        options.upload = {
          signedUploadUrl: flags['signed-upload-url'],
        };
      }

      this.info(`Syncing ${syncPath} to instance ${id}...`);
      const syncStart = Date.now();
      const syncOptions = {
        watch: false,
        install: false,
        basisCacheDir: flags['basis-cache-dir'],
        maxPatchBytes: flags['max-patch-bytes'],
        ignore: compileIgnorePatterns(flags.ignore),
        additionalFiles: parseAdditionalFileFlags(flags['additional-file']),
      };
      await xcodeClient.sync(syncPath, syncOptions as Parameters<typeof xcodeClient.sync>[1]);
      const syncDuration = formatDurationMs(Date.now() - syncStart);
      this.info(`Sync complete in ${syncDuration}.`);

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
      if (flags.upload && result.signedDownloadUrl) {
        this.output(`Artifact download URL: ${result.signedDownloadUrl}`);
      }
    });
  }
}
