import { readFile } from 'node:fs/promises';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { compileIgnorePatterns } from '../../lib/ignore-patterns';
import { formatDurationMs } from '../../lib/duration';
import { formatBytes } from '../../lib/bytes';
import { parseCacheConfig } from '../../lib/cache';
import { cacheFlags } from '../../lib/cache-flags';
import { parseAdditionalFileFlags } from '../../lib/additional-files';
import { registerCreatedInstance, type LastIosInstance, type LastXcodeInstance } from '../../lib/config';
import { webhookConfigFromFlags } from '../../lib/webhook-options';
import { parseUploadOptions } from '../../lib/upload-options';
import {
  cloudSigningFlagsProblem,
  hasCloudSigningFlags,
  hasSigningFlags,
  signingFlagsProblem,
  type XcodeCloudSigningFlagValues,
  type XcodeSigningFlagValues,
} from '../../lib/xcode-signing-options';
import {
  parseBuildSettingEntries,
  type AppStoreUploadConfig,
  type XcodeBuildOptions,
  type XcodeClient,
  type XcodeCloudSigningConfig,
  type XcodeCloudSigningMethod,
  type XcodeSigningConfig,
} from '@limrun/api';

const DEVICE_SDKS = new Set(['iphoneos', 'watchos']);
const SIMULATOR_SDKS = new Set(['iphonesimulator', 'watchsimulator']);
type AppStoreFlags = {
  'upload-to-appstore': boolean;
  'asc-key-id'?: string;
  'asc-issuer-id'?: string;
  'asc-key'?: string;
  'asc-wait-timeout'?: number;
  'auto-build-number': boolean;
};

export default class XcodeBuild extends BaseCommand {
  static summary = 'Run xcodebuild on an Xcode sandbox';
  static description =
    'Sync a local project path once (or the current working directory if omitted), then trigger a remote xcodebuild with streaming output. Use `--detach` with a webhook for headless builds that should return as soon as the build starts. Use `--ios` to build and run on an iOS simulator-backed Xcode target.';

  static examples = [
    '<%= config.bin %> xcode build',
    '<%= config.bin %> xcode build ./MyProject',
    '<%= config.bin %> xcode build ./MyProject --ios',
    '<%= config.bin %> xcode build --id <xcode-instance-ID>',
    '<%= config.bin %> xcode build ./MyProject --id <xcode-instance-ID>',
    '<%= config.bin %> xcode build --scheme MyApp --workspace MyApp.xcworkspace',
    '<%= config.bin %> xcode build --cache-key myapp-pr51 --cache-restore-keys "myapp-pr51,myapp-main"',
    '<%= config.bin %> xcode build --configuration Debug',
    '<%= config.bin %> xcode build ./ExpoApp --configuration Debug --dev-server-url https://abc123.exp.direct',
    '<%= config.bin %> xcode build ./repo --expo-app-dir apps/mobile --configuration Debug --dev-server-url "myapp://expo-development-client/?url=http%3A%2F%2F10.244.7.112%3A57090"',
    '<%= config.bin %> xcode build --scheme WatchApp --sdk watchsimulator',
    '<%= config.bin %> xcode build ./MyProject --xcodegen-spec specs/app.yml --xcodegen-project ios',
    '<%= config.bin %> xcode build ./MyProject --scheme MyApp --certificate-p12 ./certificate.p12 --certificate-password "$P12_PASSWORD" --provisioning-profile ./profile.mobileprovision --upload signed-device-build.ipa',
    '<%= config.bin %> xcode build ./MyProject --sdk iphoneos --configuration Release --signing-method release-testing --team-id VMBY3VYW4U --asc-key-id 2X9R4HXF34 --asc-issuer-id "$ASC_ISSUER_ID" --asc-key ./AuthKey_2X9R4HXF34.p8 --upload signed-device-build.ipa',
    '<%= config.bin %> xcode build ./MyProject --sdk iphoneos --configuration Release --signing-method app-store-connect --team-id VMBY3VYW4U --asc-key-id 2X9R4HXF34 --asc-issuer-id "$ASC_ISSUER_ID" --asc-key ./AuthKey_2X9R4HXF34.p8 --upload-to-appstore',
    '<%= config.bin %> xcode build ./MyProject --scheme MyApp --certificate-p12 ./certificate.p12 --certificate-password "$P12_PASSWORD" --provisioning-profile ./profile.mobileprovision --upload-to-appstore --asc-key-id 2X9R4HXF34 --asc-issuer-id "$ASC_ISSUER_ID" --asc-key ./AuthKey_2X9R4HXF34.p8',
    '<%= config.bin %> xcode build ./MyProject --scheme MyApp --certificate-p12 ./certificate.p12 --certificate-password "$P12_PASSWORD" --provisioning-profile ./app.mobileprovision --provisioning-profile ./widgets.mobileprovision --upload-to-appstore --asc-key-id 2X9R4HXF34 --asc-key ./AuthKey_2X9R4HXF34.p8',
    '<%= config.bin %> xcode build --id <ios-instance-ID> --project MyApp.xcodeproj --upload ios-build.zip',
    '<%= config.bin %> xcode build --signed-upload-url <url>',
    '<%= config.bin %> xcode build ./MyProject --scheme "MyApp Dev" --upload myapp-dev-build --upload-product-name MyApp-dev',
    `<%= config.bin %> xcode build ./MyProject --build-setting 'SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) LIMRUN' --build-setting APP_CONFIG_DEV_LOGIN_SECRET="$DEV_LOGIN_SECRET"`,
    '<%= config.bin %> xcode build ./MyProject --webhook-url https://ci.example.com/hooks/limrun --webhook-header Authorization="Bearer $HOOK_SECRET"',
    '<%= config.bin %> xcode build ./MyProject --detach --inactivity-timeout 3s --webhook-url https://ci.example.com/hooks/limrun',
    '<%= config.bin %> xcode build ./MyProject --basis-cache-dir ./.limsync-cache',
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
        'Xcode instance ID to build on, or an explicit iOS instance ID with `--xcode` enabled. Defaults to the most recent standalone Xcode target.',
    }),
    'inactivity-timeout': Flags.string({
      description:
        'Inactivity timeout for the instance created by this build (for example 3s, 1m). Forces a fresh instance and cannot be combined with --id. The timeout is measured from the last server-reported activity, so it does not interrupt an active build.',
    }),
    ios: Flags.boolean({
      description:
        'Build on an iOS simulator-backed Xcode target. Reuses a recent iOS-backed target or creates one unless --no-create is passed.',
      default: false,
    }),
    scheme: Flags.string({ description: 'Xcode scheme to build, such as MyApp' }),
    workspace: Flags.string({
      description: 'Workspace file to pass to xcodebuild, such as MyApp.xcworkspace',
    }),
    project: Flags.string({ description: 'Project file to pass to xcodebuild, such as MyApp.xcodeproj' }),
    'xcodegen-spec': Flags.string({
      description:
        'XcodeGen project spec path relative to the synced folder root, like `xcodegen generate --spec`. Forces server-side generation with the bundled XcodeGen. Omit to use project.yml at the root.',
    }),
    'xcodegen-project': Flags.string({
      description:
        "Directory (relative to the synced folder root) the Xcode project is generated into, like `xcodegen generate --project`. Forces server-side generation. Defaults to the spec file's directory.",
    }),
    'xcodegen-project-root': Flags.string({
      description:
        "Project root directory (relative to the synced folder root) that relative paths in the spec resolve against, like `xcodegen generate --project-root`. Forces server-side generation. Defaults to the spec file's directory.",
    }),
    sdk: Flags.string({
      description: 'SDK family to build for.',
      options: ['iphonesimulator', 'iphoneos', 'watchsimulator', 'watchos'],
    }),
    configuration: Flags.string({
      description: 'Xcode build configuration.',
      options: ['Debug', 'Release'],
    }),
    'git-init': Flags.boolean({
      description:
        'Run git init in the synced workspace before project generation, dependency resolution, and xcodebuild.',
      default: false,
    }),
    'dev-server-url': Flags.string({
      description:
        'Launch URL for Debug React Native / Expo builds. If the build is installed on an attached iOS simulator, the app opens this URL unchanged after build; otherwise this option has no launch effect. For Expo dev-client builds, pass the exact dev-client URL or development server URL you want opened.',
    }),
    'expo-app-dir': Flags.string({
      description:
        'Relative path from the synced workspace root to the Expo app directory. Use for monorepos or ambiguous React Native workspaces.',
    }),
    upload: Flags.string({ description: 'Upload the resulting build artifact as an asset with this name' }),
    'upload-product-name': Flags.string({
      description:
        'Product name of the built app without the .app extension, e.g. MyApp-dev when the artifact is MyApp-dev.app. The server takes the artifact from <name>.app in the built products directory verbatim, skipping product-name discovery. Use when the scheme name differs from PRODUCT_NAME and the artifact is not found after a successful build.',
    }),
    'upload-option': Flags.string({
      multiple: true,
      dependsOn: ['upload'],
      description:
        'App metadata to record on the uploaded asset as key=value, repeatable. Keys: displayName, bundleIdentifier, shortVersion, buildVersion, deeplink. limbuild extracts the same metadata from the built bundle and overwrites it; values set here survive only for fields the bundle does not declare (e.g. deeplink).',
    }),
    'signed-upload-url': Flags.string({
      description: 'Presigned URL to upload the resulting build artifact to.',
    }),
    'build-setting': Flags.string({
      description:
        'Xcode build setting to pass as KEY=VALUE. Allowed keys are a server-maintained allowlist of safe settings (e.g. SWIFT_ACTIVE_COMPILATION_CONDITIONS) plus any APP_CONFIG_* key. Repeat for multiple.',
      multiple: true,
    }),
    'certificate-p12': Flags.string({
      description:
        'Path to a PKCS#12 (.p12) signing certificate. Requires --certificate-password and --provisioning-profile.',
    }),
    'certificate-password': Flags.string({
      description: 'Password for the PKCS#12 signing certificate.',
    }),
    'provisioning-profile': Flags.string({
      description:
        'Path to a .mobileprovision profile. Requires --certificate-p12 and --certificate-password. Repeat for an app with embedded extensions (widgets, watch apps): one profile per bundle, all for the same certificate; each is matched to its bundle by the application-identifier inside the profile.',
      multiple: true,
      // One value per occurrence: greedy mode would swallow a positional
      // project path placed after the flag as another profile.
      multipleNonGreedy: true,
    }),
    'signing-method': Flags.string({
      description:
        'Use Apple cloud signing during archive export. Distribution methods require the ASC key to have access to cloud-managed distribution certificates.',
      options: ['app-store-connect', 'release-testing', 'debugging'],
    }),
    'team-id': Flags.string({
      description: 'Apple Developer team ID for --signing-method, e.g. VMBY3VYW4U.',
    }),
    'upload-to-appstore': Flags.boolean({
      description:
        'Upload the signed IPA to App Store Connect after the build, making it available for TestFlight or App Store distribution. Requires manual or cloud signing plus --asc-key-id and --asc-key.',
      default: false,
    }),
    'asc-key-id': Flags.string({
      description: 'App Store Connect API key ID for cloud signing or --upload-to-appstore, e.g. 2X9R4HXF34.',
    }),
    'asc-issuer-id': Flags.string({
      description: 'App Store Connect issuer ID for team API keys. Omit when using an individual API key.',
    }),
    'asc-key': Flags.string({
      description: 'Path to the App Store Connect API private key (.p8) for cloud signing or upload.',
    }),
    'asc-wait-timeout': Flags.integer({
      description:
        "How many seconds to watch for App Store Connect's processing verdict after the upload. A rejection within the window fails the build; expiry without a verdict succeeds with the build still processing. Defaults to 0 (return as soon as the upload commits; processing routinely takes many minutes), max 1800.",
      min: 0,
      max: 1800,
    }),
    'auto-build-number': Flags.boolean({
      description:
        'Set the build number to one more than the highest already in App Store Connect (1 for a new app), so repeat uploads never collide on CFBundleVersion. Resolved server-side with the ASC key. Requires --upload-to-appstore; manual signing also requires Xcode-standard versioning (CFBundleVersion = $(CURRENT_PROJECT_VERSION)).',
      default: false,
    }),
    'webhook-url': Flags.string({
      description:
        'HTTPS URL that limbuild POSTs a JSON payload to once the build reaches a terminal state, carrying the result, a console debug link, and a presigned build-log URL. Must be a public DNS host; IP-literal and private targets are rejected. Delivery is best-effort and never fails the build.',
    }),
    'webhook-header': Flags.string({
      description:
        'Header to set verbatim on the webhook request as NAME=VALUE, for example Authorization="Bearer $SECRET". Requires --webhook-url. Repeat for multiple headers (at most 16).',
      multiple: true,
    }),
    detach: Flags.boolean({
      description:
        'Return after the remote build is accepted instead of streaming logs and waiting for completion. Requires --webhook-url; use its callback to observe the terminal result.',
      default: false,
    }),
    'basis-cache-dir': Flags.string({
      description: 'Directory to use for the client-side delta sync cache during the pre-build sync step.',
    }),
    ignore: Flags.string({
      description:
        'Regular expression to ignore matching relative paths during the pre-build sync. Repeat for multiple patterns.',
      multiple: true,
    }),
    include: Flags.string({
      description:
        'Regular expression to force-sync matching relative paths even when excluded by a built-in rule or .gitignore (for example --include "^\\\\.git/" or --include "^ios/GeneratedKit/"). The client-side basis cache is never included. If a parent directory is itself excluded, the pattern must also match that directory (e.g. use "^ios/" not "GeneratedKit/") or the subtree stays pruned. Repeat for multiple patterns.',
      multiple: true,
    }),
    'additional-file': Flags.string({
      description:
        'Additional file to sync before building as localPath=remotePath, for example ~/.netrc=~/.netrc. Repeat for multiple files.',
      multiple: true,
    }),
    ...cacheFlags,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(XcodeBuild);
    this.setParsedFlags(flags);
    if (flags['dev-server-url'] && flags.configuration === 'Release') {
      this.error('--dev-server-url is only supported for Debug builds.');
    }
    if (flags.ios && flags.sdk && DEVICE_SDKS.has(flags.sdk)) {
      this.error(
        '--ios builds run on a simulator. Use --sdk iphonesimulator, --sdk watchsimulator, or omit --sdk.',
      );
    }
    if (
      (flags['xcodegen-spec'] || flags['xcodegen-project'] || flags['xcodegen-project-root']) &&
      (flags['dev-server-url'] || flags['expo-app-dir'])
    ) {
      this.error(
        '--xcodegen-spec/--xcodegen-project apply to native XcodeGen projects and cannot be combined with Expo / React Native flags.',
      );
    }
    if (flags.ios && (hasSigningFlags(flags) || hasCloudSigningFlags(flags))) {
      this.error('--ios builds run on a simulator and cannot use signing flags.');
    }
    const signingProblem = signingFlagsProblem(flags);
    if (signingProblem) {
      // Rejected before instance resolution: a doomed flag combination must
      // not leave a billed instance behind.
      this.error(signingProblem);
    }
    const cloudSigningProblem = cloudSigningFlagsProblem(flags);
    if (cloudSigningProblem) {
      this.error(cloudSigningProblem);
    }
    if (flags.ios && (flags['upload-to-appstore'] || hasAppStoreFlags(flags))) {
      this.error('--ios builds run on a simulator and cannot upload to App Store Connect.');
    }
    if (flags.id && flags['inactivity-timeout']) {
      this.error('--inactivity-timeout controls a newly created instance and cannot be combined with --id.');
    }
    if (flags.detach && !flags['webhook-url']) {
      this.error('--detach requires --webhook-url so the terminal build result is observable.');
    }

    await this.withAuth(async () => {
      const target =
        flags.ios ?
          await this.resolveSimulatorBackedXcodeTargetOrCreate(flags.id)
        : await this.resolveXcodeTargetOrCreate(flags.id);
      const id = target.id;
      await this.applyBuildCacheToTarget(target, parseCacheConfig(flags));
      const syncPath = args.path ?? process.cwd();
      const xcodeClient = await this.resolveXcodeClient(target);

      const settings: Record<string, string> = {};
      if (flags.scheme) settings.scheme = flags.scheme;
      if (flags.workspace) settings.workspace = flags.workspace;
      if (flags.project) settings.project = flags.project;
      if (flags.sdk) settings.sdk = flags.sdk;
      if (flags.ios && !flags.sdk) settings.sdk = 'iphonesimulator';
      if (flags.configuration) settings.configuration = flags.configuration;
      if (flags['upload-product-name']) {
        const productName = flags['upload-product-name'];
        if (productName.endsWith('.app')) {
          this.error('--upload-product-name takes the product name without the .app extension.');
        }
        if (productName.includes('/') || productName === '.' || productName === '..') {
          this.error('--upload-product-name must be a plain filename without path separators.');
        }
        settings.productName = productName;
      }

      const options: XcodeBuildOptions = {};
      if (flags['git-init']) {
        options.gitInit = true;
      }
      if (flags['xcodegen-spec'] || flags['xcodegen-project'] || flags['xcodegen-project-root']) {
        options.xcodegen = {
          ...(flags['xcodegen-spec'] && { spec: flags['xcodegen-spec'] }),
          ...(flags['xcodegen-project'] && { project: flags['xcodegen-project'] }),
          ...(flags['xcodegen-project-root'] && { projectRoot: flags['xcodegen-project-root'] }),
        };
      }
      if (flags['dev-server-url'] || flags['expo-app-dir']) {
        options.reactNative = {
          ...(flags['expo-app-dir'] && { expoAppDir: flags['expo-app-dir'] }),
          ...(flags['dev-server-url'] && { devServerURL: flags['dev-server-url'] }),
        };
      }
      const buildSettings = parseBuildSettingEntries(flags['build-setting'] ?? []);
      if (buildSettings) {
        options.buildSettings = buildSettings;
      }
      const signing = await this.buildSigningOptions(flags);
      if (signing) {
        if (flags.sdk && SIMULATOR_SDKS.has(flags.sdk)) {
          this.error('Signing is only supported for device SDK builds. Use --sdk iphoneos or --sdk watchos.');
        }
        if (!flags.sdk) {
          settings.sdk = 'iphoneos';
        } else if (!DEVICE_SDKS.has(flags.sdk)) {
          this.error('Signing is only supported for device SDK builds. Use --sdk iphoneos or --sdk watchos.');
        }
        options.signing = signing;
      }
      const cloudSigning = await this.buildCloudSigningOptions(flags);
      if (cloudSigning) {
        if (flags.sdk && flags.sdk !== 'iphoneos') {
          this.error('Cloud signing requires --sdk iphoneos.');
        }
        settings.sdk = 'iphoneos';
        options.cloudSigning = cloudSigning;
      }
      if (
        !flags['upload-to-appstore'] &&
        (flags['asc-wait-timeout'] !== undefined || flags['auto-build-number'])
      ) {
        this.error('--asc-wait-timeout and --auto-build-number require --upload-to-appstore.');
      }
      if (!flags['upload-to-appstore'] && !cloudSigning && hasASCCredentialFlags(flags)) {
        this.error('The asc credential flags require --signing-method or --upload-to-appstore.');
      }
      if (flags['upload-to-appstore']) {
        if (!signing && !cloudSigning) {
          this.error(
            '--upload-to-appstore delivers a signed IPA, so it requires manual signing flags or --signing-method.',
          );
        }
        if (settings.sdk !== 'iphoneos') {
          this.error('--upload-to-appstore requires --sdk iphoneos.');
        }
        options.appstore = await this.buildAppStoreOptions(flags);
      }
      if (flags.upload && flags['signed-upload-url']) {
        this.error('Use either --upload or --signed-upload-url, not both.');
      }
      if (flags.upload) {
        let uploadOptions;
        try {
          uploadOptions = parseUploadOptions(flags['upload-option']);
        } catch (err) {
          this.error(err instanceof Error ? err.message : String(err));
        }
        options.upload = { assetName: flags.upload, ...(uploadOptions && { uploadOptions }) };
      } else if (flags['signed-upload-url']) {
        options.upload = {
          signedUploadUrl: flags['signed-upload-url'],
        };
      }
      try {
        const webhook = webhookConfigFromFlags(flags);
        if (webhook) {
          options.webhook = webhook;
        }
      } catch (err) {
        this.error(err instanceof Error ? err.message : String(err));
      }

      this.info(`Syncing ${syncPath} to instance ${id}...`);
      const syncStart = Date.now();
      const syncOptions = {
        watch: false,
        install: false,
        basisCacheDir: flags['basis-cache-dir'],
        ignore: compileIgnorePatterns(flags.ignore),
        include: compileIgnorePatterns(flags.include),
        additionalFiles: parseAdditionalFileFlags(flags['additional-file']),
      };
      const syncResult = await xcodeClient.sync(
        syncPath,
        syncOptions as Parameters<typeof xcodeClient.sync>[1],
      );
      const syncDuration = formatDurationMs(Date.now() - syncStart);
      const syncedSize =
        syncResult.bytesSent !== undefined ? ` (${formatBytes(syncResult.bytesSent)} sent)` : '';
      this.info(`Sync completed in ${syncDuration}${syncedSize}.`);

      this.info('Starting xcodebuild...');

      const proc = xcodeClient.xcodebuild(
        Object.keys(settings).length > 0 ? settings : undefined,
        Object.keys(options).length > 0 ? options : undefined,
      );

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
          // 'timeout' means the stream was alive and the work outlived the
          // budget; a lost or closed stream means the execution may be gone.
          this.error(
            result.incomplete && result.incomplete.reason !== 'timeout' ?
              `${result.incomplete.message}.`
            : 'Timed out waiting for the build to finish; the remote build may still be running. Check the instance before retrying.',
            { exit: result.exitCode },
          );
        }
        if (result.appstore?.state === 'failed') {
          this.error(
            "App Store Connect upload failed; the build and signing succeeded. See Apple's response in the log above.",
            { exit: result.exitCode },
          );
        }
        this.error(`xcodebuild failed with exit code ${result.exitCode}`, { exit: result.exitCode });
      }

      this.output(`\nBuild succeeded (exit code ${result.exitCode})`);
      if (result.appstore?.state === 'accepted') {
        this.output('App Store Connect: upload accepted.');
      } else if (result.appstore?.state === 'processing') {
        this.output(
          `App Store Connect: uploaded, still processing on Apple's side (upload ${
            result.appstore.uploadId ?? 'unknown'
          }).`,
        );
      } else if (result.appstore?.state === 'unknown') {
        this.output('App Store Connect: upload status could not be read; check App Store Connect.');
      }
      if (flags.ios) {
        const signedStreamUrl = await this.resolveSimulatorStreamUrl(target, xcodeClient);
        if (signedStreamUrl) {
          this.output(`Signed Stream URL: ${signedStreamUrl}`);
        } else if (target.type === 'ios') {
          this.output(`iOS Simulator URL: ${this.consoleStreamUrl(target.id)}`);
        }
      }
      if (flags.upload && result.signedDownloadUrl) {
        this.output(`Artifact download URL: ${result.signedDownloadUrl}`);
      }
    });
  }

  private async buildSigningOptions(flags: XcodeSigningFlagValues): Promise<XcodeSigningConfig | undefined> {
    // Flag completeness was validated before instance resolution.
    if (!hasSigningFlags(flags)) {
      return undefined;
    }
    const [certificateP12Base64, ...provisioningProfilesBase64] = await Promise.all([
      this.readFileBase64(flags['certificate-p12']!, '--certificate-p12'),
      ...flags['provisioning-profile']!.map((path) => this.readFileBase64(path, '--provisioning-profile')),
    ]);
    return {
      certificateP12Base64,
      certificatePassword: flags['certificate-password']!,
      provisioningProfilesBase64,
    };
  }

  private async buildCloudSigningOptions(
    flags: XcodeCloudSigningFlagValues,
  ): Promise<XcodeCloudSigningConfig | undefined> {
    if (!flags['signing-method']) {
      return undefined;
    }
    return {
      method: flags['signing-method'] as XcodeCloudSigningMethod,
      teamId: flags['team-id']!,
      apiKeyId: flags['asc-key-id']!,
      apiIssuerId: flags['asc-issuer-id']!,
      apiPrivateKeyBase64: await this.readFileBase64(flags['asc-key']!, '--asc-key'),
    };
  }

  private async readFileBase64(path: string, flagName: string): Promise<string> {
    try {
      return (await readFile(path)).toString('base64');
    } catch (err) {
      this.error(`Failed to read ${flagName} file at ${path}: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async buildAppStoreOptions(flags: AppStoreFlags): Promise<AppStoreUploadConfig> {
    if (!flags['asc-key-id'] || !flags['asc-key']) {
      this.error('--upload-to-appstore requires both --asc-key-id and --asc-key.');
    }
    return {
      apiKeyId: flags['asc-key-id'],
      ...(flags['asc-issuer-id'] && { apiIssuerId: flags['asc-issuer-id'] }),
      apiPrivateKeyBase64: await this.readFileBase64(flags['asc-key'], '--asc-key'),
      ...(flags['asc-wait-timeout'] !== undefined && { waitTimeoutSeconds: flags['asc-wait-timeout'] }),
      ...(flags['auto-build-number'] && { autoIncrementBuildNumber: true }),
    };
  }

  private async resolveIosSignedStreamUrl(target: LastIosInstance): Promise<string | undefined> {
    const cached = target.signedStreamUrl ?? this.signedStreamUrl(target.status);
    if (cached) {
      return cached;
    }
    try {
      const instance = await this.client.iosInstances.get(target.id);
      return this.signedStreamUrl(instance.status);
    } catch {
      return undefined;
    }
  }

  private async resolveSimulatorStreamUrl(
    target: LastIosInstance | LastXcodeInstance,
    xcodeClient: XcodeClient,
  ): Promise<string | undefined> {
    if (target.type === 'ios') {
      return this.resolveIosSignedStreamUrl(target);
    }
    try {
      const status = await xcodeClient.getSimulator();
      const iosInstanceId = status.simulator?.iosInstanceId;
      if (!iosInstanceId) {
        return undefined;
      }
      try {
        const simulator = await this.client.iosInstances.get(iosInstanceId);
        registerCreatedInstance(simulator);
        return this.signedStreamUrl(simulator.status) ?? this.consoleStreamUrl(iosInstanceId);
      } catch {
        return this.consoleStreamUrl(iosInstanceId);
      }
    } catch {
      return undefined;
    }
  }
}

function hasAppStoreFlags(flags: AppStoreFlags): boolean {
  return (
    flags['asc-key-id'] !== undefined ||
    flags['asc-issuer-id'] !== undefined ||
    flags['asc-key'] !== undefined ||
    flags['asc-wait-timeout'] !== undefined ||
    flags['auto-build-number']
  );
}

function hasASCCredentialFlags(flags: AppStoreFlags): boolean {
  return (
    flags['asc-key-id'] !== undefined ||
    flags['asc-issuer-id'] !== undefined ||
    flags['asc-key'] !== undefined
  );
}
