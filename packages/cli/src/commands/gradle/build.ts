import { readFile } from 'node:fs/promises';
import { Args, Flags } from '@oclif/core';
import { type GradleBuildOptions } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import { compileIgnorePatterns } from '../../lib/ignore-patterns';
import {
  gradleAndroidABIs,
  gradleBuildOptionsFromFlags,
  tasksIncludeBundle,
} from '../../lib/gradle-build-options';
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
    'Use `--upload` to store the artifact, or `--detach` with a webhook for a headless build that returns as soon as the build starts.';

  static examples = [
    '<%= config.bin %> gradle build',
    '<%= config.bin %> gradle build ./my-app --artifact-name app-dev-debug.apk --upload myapp.apk --upload-ttl 24h',
    '<%= config.bin %> gradle build --task bundleRelease',
    '<%= config.bin %> gradle build --id <gradle-instance-ID> --project-path android',
    '<%= config.bin %> gradle build ./my-monorepo --expo-app-dir apps/mobile',
    '<%= config.bin %> gradle build --sign --upload myapp.aab',
    '<%= config.bin %> gradle build --keystore upload.jks --keystore-password *** --key-alias upload --key-password *** --save-key',
    '<%= config.bin %> gradle build ./my-app --webhook-url https://ci.example.com/hooks/limrun --webhook-header Authorization="Bearer $HOOK_SECRET"',
    '<%= config.bin %> gradle build ./my-app --detach --inactivity-timeout 3s --webhook-url https://ci.example.com/hooks/limrun',
    '<%= config.bin %> gradle build --sign --upload-to-playstore --playstore-service-account service-account.json',
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
    'inactivity-timeout': Flags.string({
      description:
        'Inactivity timeout for the instance created by this build (for example 3s, 1m). Forces a fresh instance and cannot be combined with --id. Active builds count as activity.',
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
    upload: Flags.string({ description: 'Upload the resulting APK or AAB as an asset with this name.' }),
    'upload-ttl': Flags.string({
      description:
        'Delete the named --upload asset after this Go duration (for example 24h or 30m). Omit for no expiry.',
    }),
    'artifact-name': Flags.string({
      description:
        'Exact APK or AAB filename to upload when the build produces multiple artifacts, for example app-prod-release.aab.',
    }),
    'signed-upload-url': Flags.string({
      description: 'Presigned URL to upload the resulting APK or AAB to.',
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
    'webhook-url': Flags.string({
      description:
        'HTTPS URL that the build daemon POSTs a JSON payload to once the build reaches a terminal state, carrying the result and a console debug link. Must be a public DNS host; IP-literal and private targets are rejected. Delivery is best-effort and never fails the build.',
    }),
    'webhook-header': Flags.string({
      description:
        'Header to set verbatim on the webhook request as NAME=VALUE, for example Authorization="Bearer $SECRET". Requires --webhook-url. Repeat for multiple headers (at most 16).',
      multiple: true,
    }),
    'upload-to-playstore': Flags.boolean({
      description:
        'Publish the signed AAB to a Google Play track after a successful build. Requires signing plus either --playstore-service-account or --playstore-access-token; the app listing must already exist in Play Console.',
      default: false,
    }),
    'playstore-service-account': Flags.string({
      description:
        'Path to a service-account JSON key whose email is invited in Play Console, for --upload-to-playstore.',
    }),
    'playstore-access-token': Flags.string({
      description:
        'Short-lived Google OAuth token carrying androidpublisher scope. Prefer LIM_PLAYSTORE_ACCESS_TOKEN so the token is not exposed in shell history.',
      env: 'LIM_PLAYSTORE_ACCESS_TOKEN',
    }),
    'playstore-track': Flags.string({
      description:
        "Play track ID for --upload-to-playstore: internal (default), alpha, beta, production, or a custom track. Publishing replaces the track's existing releases.",
    }),
    'playstore-release-status': Flags.string({
      description:
        'completed makes the release live on the track; draft commits it without rollout. Required explicitly for the production track.',
      options: ['draft', 'completed'],
    }),
    'playstore-package': Flags.string({
      description: 'Package name to publish under. Omit to read it from the built AAB.',
    }),
    detach: Flags.boolean({
      description:
        'Return after the remote build is accepted instead of streaming logs and waiting for completion. Requires --webhook-url; use its callback to observe the terminal result.',
      default: false,
    }),
    'auto-version-code': Flags.boolean({
      description:
        'Set the versionCode to one more than the highest already on Google Play before the build, so repeat publishes never collide. Requires --upload-to-playstore; needs a static app.json (Expo) or a single literal versionCode in the conventional app/ module build script (native).',
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
          keystorePassword: flags['keystore-password'],
          keyAlias: flags['key-alias'],
          keyPassword: flags['key-password'],
        });
      }
    } catch (err) {
      return this.error(err instanceof Error ? err.message : String(err));
    }
    if (flags.id && flags['inactivity-timeout']) {
      return this.error(
        '--inactivity-timeout controls a newly created instance and cannot be combined with --id.',
      );
    }
    if (flags.detach && !flags['webhook-url']) {
      return this.error('--detach requires --webhook-url so the terminal build result is observable.');
    }
    if (flags['upload-to-playstore']) {
      let credential: Pick<
        NonNullable<GradleBuildOptions['playstore']>,
        'accessToken' | 'serviceAccountJsonBase64'
      >;
      if (flags['playstore-service-account']) {
        try {
          credential = {
            serviceAccountJsonBase64: (await readFile(flags['playstore-service-account'])).toString('base64'),
          };
        } catch (err) {
          return this.error(
            `Failed to read --playstore-service-account file at ${flags['playstore-service-account']}: ${
              err instanceof Error ? err.message : err
            }`,
          );
        }
      } else {
        credential = { accessToken: flags['playstore-access-token']! };
      }
      options.playstore = {
        ...credential,
        ...(flags['auto-version-code'] && { autoIncrementVersionCode: true }),
        ...(flags['playstore-track'] && { track: flags['playstore-track'] }),
        ...(flags['playstore-release-status'] && {
          releaseStatus: flags['playstore-release-status'] as 'draft' | 'completed',
        }),
        ...(flags['playstore-package'] && { packageName: flags['playstore-package'] }),
      };
    }

    await this.withAuth(async () => {
      // Escrow round-trips run BEFORE resolveGradleTargetOrCreate for the
      // same reason flag validation does: a failure here must not leave a
      // freshly created billed instance behind.
      if (applicationId && flags['save-key'] && options.signing) {
        const saved = await saveProvidedKey(this.client, applicationId, options.signing);
        this.info(
          saved ?
            `Escrowed the provided keystore as the organization's upload key for ${applicationId}.`
          : `The provided keystore is already escrowed for ${applicationId}.`,
        );
      } else if (applicationId && flags.sign) {
        const { signing, created } = await resolveEscrowedSigning(this.client, applicationId);
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

      if (flags.detach) {
        const execId = await proc.detach();
        // --detach requires --webhook-url, validated above.
        const webhookUrl = flags['webhook-url']!;
        const consoleUrl = this.consoleBuildUrl(id);
        if (this.isJsonEnabled()) {
          this.outputJson({ instanceId: id, execId, consoleUrl, webhookUrl });
        } else {
          this.output(`Build started (exec ID ${execId}) on instance ${id}.`);
          this.output(`Console: ${consoleUrl}`);
          this.output(`Completion will be reported by webhook to ${webhookUrl}.`);
        }
        return;
      }

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
        if (result.playstore?.state === 'failed') {
          const code = result.playstore.code ? ` [${result.playstore.code}]` : '';
          this.error(
            `Play Store publish failed${code}: ${
              result.playstore.message ?? 'see the build log above'
            }. The build and signing succeeded.`,
            { exit: result.exitCode },
          );
        }
        this.error(`gradle build failed with exit code ${result.exitCode}`, { exit: result.exitCode });
      }

      this.output(`\nBuild succeeded (exit code ${result.exitCode})`);
      // Signing only yields a Play-ready AAB when a bundle task ran (no
      // explicit tasks means the server defaulted to bundleRelease); a BYO
      // keystore with an explicit assemble task still produces an APK.
      const builtSignedBundle = options.signing && (!flags.task?.length || tasksIncludeBundle(flags.task));
      if (flags.upload && builtSignedBundle) {
        this.output(`Uploaded the signed app bundle as asset '${flags.upload}'.`);
      } else if (flags.upload) {
        this.output(`Uploaded APK as asset '${flags.upload}'.`);
        this.output(`Run it with: lim android create --install-asset=${flags.upload}`);
      }
      if (result.playstore?.state === 'accepted') {
        const track = result.playstore.track ?? options.playstore?.track ?? 'internal';
        const versionCode =
          result.playstore.versionCode !== undefined ? ` as versionCode ${result.playstore.versionCode}` : '';
        this.output(`Published to the Play ${track} track${versionCode}.`);
      } else if (options.playstore && !result.playstore) {
        // The playstore SSE event doubles as the capability handshake: its
        // absence on success means the server ignored the request.
        this.warn(
          'The server reported no Play Store publish state; it may predate --upload-to-playstore. The AAB was built but likely not published.',
        );
      }
      if (result.signedDownloadUrl) {
        this.output(`Download URL: ${result.signedDownloadUrl}`);
      }
    });
  }
}
