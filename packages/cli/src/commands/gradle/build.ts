import { Args, Flags } from '@oclif/core';
import { type GradleBuildOptions } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import { compileIgnorePatterns } from '../../lib/ignore-patterns';
import { formatDurationMs } from '../../lib/duration';
import { formatBytes } from '../../lib/bytes';

export default class GradleBuild extends BaseCommand {
  static summary = 'Build an Android project on a gradle instance';
  static description =
    'Sync a local Android project once, then run its Gradle wrapper remotely with streaming output. ' +
    'Use `--upload` to store the built APK as a named asset that `lim android create --install-asset` can install.';

  static examples = [
    '<%= config.bin %> gradle build',
    '<%= config.bin %> gradle build ./my-app --upload myapp.apk',
    '<%= config.bin %> gradle build --task bundleRelease',
    '<%= config.bin %> gradle build --id <gradle-instance-ID> --project-path android',
  ];

  static args = {
    path: Args.string({
      description: 'Local project path to sync. Defaults to the current directory.',
      required: false,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Gradle instance ID to build on. Defaults to the last used or a newly created one.',
    }),
    task: Flags.string({
      description: 'Gradle task to run, such as assembleDebug. Repeat for multiple tasks.',
      multiple: true,
    }),
    'project-path': Flags.string({
      description:
        'Relative path to the Gradle root inside the synced project, for when auto-discovery is ambiguous.',
    }),
    upload: Flags.string({ description: 'Upload the resulting APK as an asset with this name' }),
    'signed-upload-url': Flags.string({
      description: 'Presigned URL to upload the resulting APK to.',
    }),
    'basis-cache-dir': Flags.string({
      description: 'Directory for the client-side folder-sync cache.',
    }),
    ignore: Flags.string({
      description:
        'Regular expression matched against relative paths to exclude from sync. Repeat for multiple patterns.',
      multiple: true,
    }),
    include: Flags.string({
      description:
        'Regular expression matched against relative paths to force-sync even when excluded by a built-in rule or .gitignore. Repeat for multiple patterns.',
      multiple: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(GradleBuild);
    this.setParsedFlags(flags);
    if (flags.upload && flags['signed-upload-url']) {
      this.error('Use either --upload or --signed-upload-url, not both.');
    }

    await this.withAuth(async () => {
      const target = await this.resolveGradleTargetOrCreate(flags.id);
      const id = target.id;
      const syncPath = args.path ?? process.cwd();
      const gradleClient = await this.resolveGradleClient(target);

      const options: GradleBuildOptions = {};
      if (flags.task && flags.task.length > 0) {
        options.tasks = flags.task;
      }
      if (flags['project-path']) {
        options.projectPath = flags['project-path'];
      }
      if (flags.upload) {
        options.upload = { assetName: flags.upload };
      } else if (flags['signed-upload-url']) {
        options.upload = { signedUploadUrl: flags['signed-upload-url'] };
      }

      this.info(`Syncing ${syncPath} to instance ${id}...`);
      const syncStart = Date.now();
      const syncResult = await gradleClient.sync(syncPath, {
        basisCacheDir: flags['basis-cache-dir'],
        ignore: compileIgnorePatterns(flags.ignore),
        include: compileIgnorePatterns(flags.include),
      });
      const syncDuration = formatDurationMs(Date.now() - syncStart);
      const syncedSize =
        syncResult.bytesSent !== undefined ? ` (${formatBytes(syncResult.bytesSent)} sent)` : '';
      this.info(`Sync completed in ${syncDuration}${syncedSize}.`);

      this.info('Starting gradle build...');
      const proc = gradleClient.gradlebuild(options);

      proc.stdout.on('data', (line: string) => {
        process.stdout.write(line + '\n');
      });
      proc.stderr.on('data', (line: string) => {
        process.stderr.write(line + '\n');
      });

      const result = await proc;

      if (result.exitCode !== 0) {
        if (result.timedOut) {
          this.error(
            'Timed out waiting for the build to finish; the remote build may still be running. Check the instance before retrying.',
            { exit: result.exitCode },
          );
        }
        this.error(`gradle build failed with exit code ${result.exitCode}`, { exit: result.exitCode });
      }

      this.output(`\nBuild succeeded (exit code ${result.exitCode})`);
      if (flags.upload) {
        this.output(`Uploaded APK as asset '${flags.upload}'.`);
        this.output(`Run it with: lim android create --install-asset=${flags.upload}`);
      }
      if (result.signedDownloadUrl) {
        this.output(`Download URL: ${result.signedDownloadUrl}`);
      }
    });
  }
}
