import { Args, Flags } from '@oclif/core';
import { type GradleBuildOptions } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import { compileIgnorePatterns } from '../../lib/ignore-patterns';
import { gradleAndroidABIs, gradleBuildOptionsFromFlags } from '../../lib/gradle-build-options';
import {
  readProvidedSigning,
  resolveApplicationId,
  resolveEscrowedSigning,
  saveProvidedKey,
} from '../../lib/gradle-signing';
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
    '<%= config.bin %> gradle build ./my-monorepo --expo-app-dir apps/mobile',
    '<%= config.bin %> gradle build --sign --upload myapp.aab',
    '<%= config.bin %> gradle build --keystore upload.jks --keystore-password *** --key-alias upload --key-password *** --save-key',
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
    'expo-app-dir': Flags.string({
      description:
        'Relative path from the synced workspace root to the Expo app directory. Use for monorepos or ambiguous workspaces. Setting this (or --abi) opts the whole build into the Expo pipeline (dependency install, expo prebuild), which requires a detected Expo app.',
    }),
    abi: Flags.string({
      description:
        "Android ABI to build. Setting this (or --expo-app-dir) opts the whole build into the Expo pipeline, which requires a detected Expo app. Repeat for multiple ABIs; 'all' keeps the project's own configuration. Omitting builds x86_64 (what Limrun Android instances run) for Expo-pipeline builds, except for release and bundle tasks, which keep the project's configuration.",
      multiple: true,
      options: [...gradleAndroidABIs],
    }),
    upload: Flags.string({ description: 'Upload the resulting APK as an asset with this name' }),
    'signed-upload-url': Flags.string({
      description: 'Presigned URL to upload the resulting APK to.',
    }),
    sign: Flags.boolean({
      description:
        "Sign the release build with the organization's escrowed upload key for this app, generating and escrowing one on first use. Makes bundleRelease the default task.",
      default: false,
    }),
    'application-id': Flags.string({
      description:
        'Android application ID naming the escrowed key. Defaults to the value detected from app.json or app/build.gradle.',
    }),
    keystore: Flags.string({
      description:
        'Path to your own upload keystore for release signing. Requires --keystore-password, --key-alias and --key-password.',
    }),
    'keystore-password': Flags.string({
      description: 'Password of the --keystore file.',
      env: 'LIM_KEYSTORE_PASSWORD',
    }),
    'key-alias': Flags.string({ description: 'Alias of the signing key inside the --keystore file.' }),
    'key-password': Flags.string({
      description: 'Password of the key behind --key-alias.',
      env: 'LIM_KEY_PASSWORD',
    }),
    'save-key': Flags.boolean({
      description:
        "Escrow the provided --keystore as the organization's upload key for this app, so later builds can use --sign. Fails if a different key is already escrowed.",
      default: false,
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
    // Validate flags before withAuth: resolveGradleTargetOrCreate may
    // auto-create a billed instance, which a doomed flag combination must
    // never reach.
    let options: GradleBuildOptions;
    let applicationId: string | undefined;
    const syncPath = args.path ?? process.cwd();
    try {
      options = gradleBuildOptionsFromFlags(flags);
      if (flags.sign || flags['save-key']) {
        applicationId = resolveApplicationId({
          explicit: flags['application-id'],
          syncPath,
          expoAppDir: flags['expo-app-dir'],
          projectPath: flags['project-path'],
        });
      }
      if (flags.keystore) {
        options.signing = readProvidedSigning({
          keystore: flags.keystore,
          keystorePassword: flags['keystore-password']!,
          keyAlias: flags['key-alias']!,
          keyPassword: flags['key-password']!,
        });
      }
    } catch (err) {
      return this.error(err instanceof Error ? err.message : String(err));
    }

    await this.withAuth(async () => {
      // Escrow round-trips run BEFORE resolveGradleTargetOrCreate for the
      // same reason flag validation does: a failure here must not leave a
      // freshly created billed instance behind.
      if (applicationId && flags['save-key'] && options.signing) {
        const saved = await saveProvidedKey(
          this.apiCredentials.apiEndpoint,
          this.apiCredentials.apiKey,
          applicationId,
          options.signing,
        );
        this.info(
          saved.created ?
            `Escrowed the provided keystore as the organization's upload key for ${applicationId}.`
          : `The provided keystore is already escrowed for ${applicationId}.`,
        );
      } else if (applicationId && flags.sign) {
        const { signing, created } = await resolveEscrowedSigning(
          this.apiCredentials.apiEndpoint,
          this.apiCredentials.apiKey,
          applicationId,
        );
        options.signing = signing;
        this.info(
          `Signing with the organization's upload key for ${applicationId} (${
            created ? 'newly generated' : 'existing'
          }).`,
        );
      }

      const target = await this.resolveGradleTargetOrCreate(flags.id);
      const id = target.id;
      const gradleClient = await this.resolveGradleClient(target);

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
      if (flags.upload && options.signing) {
        this.output(`Uploaded the signed artifact as asset '${flags.upload}'.`);
      } else if (flags.upload) {
        this.output(`Uploaded APK as asset '${flags.upload}'.`);
        this.output(`Run it with: lim android create --install-asset=${flags.upload}`);
      }
      if (result.signedDownloadUrl) {
        this.output(`Download URL: ${result.signedDownloadUrl}`);
      }
    });
  }
}
