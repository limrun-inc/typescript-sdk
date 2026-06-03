import { readFile } from 'node:fs/promises';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { compileIgnorePatterns } from '../../lib/ignore-patterns';
import { formatDurationMs } from '../../lib/duration';
import { parseAdditionalFileFlags } from '../../lib/additional-files';
import { registerCreatedInstance, type LastIosInstance, type LastXcodeInstance } from '../../lib/config';
import { parseAppConfigEntries, type XcodeBuildOptions, type XcodeClient } from '@limrun/api';

const DEVICE_SDKS = new Set(['iphoneos', 'watchos']);
const SIMULATOR_SDKS = new Set(['iphonesimulator', 'watchsimulator']);
type SigningFlags = {
  'certificate-p12'?: string;
  'certificate-password'?: string;
  'provisioning-profile'?: string;
};

export default class XcodeBuild extends BaseCommand {
  static summary = 'Run xcodebuild on an Xcode sandbox';
  static description =
    'Sync a local project path once (or the current working directory if omitted), then trigger a remote xcodebuild with streaming output. Use `--ios` to build and run on an iOS simulator-backed Xcode target.';

  static examples = [
    '<%= config.bin %> xcode build',
    '<%= config.bin %> xcode build ./MyProject',
    '<%= config.bin %> xcode build ./MyProject --ios',
    '<%= config.bin %> xcode build --id <xcode-instance-ID>',
    '<%= config.bin %> xcode build ./MyProject --id <xcode-instance-ID>',
    '<%= config.bin %> xcode build --scheme MyApp --workspace MyApp.xcworkspace',
    '<%= config.bin %> xcode build --configuration Debug',
    '<%= config.bin %> xcode build ./ExpoApp --configuration Debug --dev-server-url https://abc123.exp.direct',
    '<%= config.bin %> xcode build ./repo --expo-app-dir apps/mobile --configuration Debug --dev-server-url "myapp://expo-development-client/?url=http%3A%2F%2F10.244.7.112%3A57090"',
    '<%= config.bin %> xcode build --scheme WatchApp --sdk watchsimulator',
    '<%= config.bin %> xcode build ./MyProject --scheme MyApp --certificate-p12 ./certificate.p12 --certificate-password "$P12_PASSWORD" --provisioning-profile ./profile.mobileprovision --upload signed-device-build.ipa',
    '<%= config.bin %> xcode build --id <ios-instance-ID> --project MyApp.xcodeproj --upload ios-build.zip',
    '<%= config.bin %> xcode build --signed-upload-url <url>',
    '<%= config.bin %> xcode build ./MyProject --app-config PREVIEW_BUILD=true --app-config DEV_LOGIN_SECRET="$DEV_LOGIN_SECRET"',
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
        'Xcode instance ID to build on, or an explicit iOS instance ID with `--xcode` enabled. Defaults to the most recent standalone Xcode target.',
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
    sdk: Flags.string({
      description: 'SDK family to build for.',
      options: ['iphonesimulator', 'iphoneos', 'watchsimulator', 'watchos'],
    }),
    configuration: Flags.string({
      description: 'Xcode build configuration.',
      options: ['Debug', 'Release'],
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
    'signed-upload-url': Flags.string({
      description: 'Presigned URL to upload the resulting build artifact to.',
    }),
    'app-config': Flags.string({
      description:
        'App config value baked into the build, as KEY=VALUE with a bare key (the APP_CONFIG_ prefix is added automatically). Repeat for multiple.',
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
        'Path to a .mobileprovision profile. Requires --certificate-p12 and --certificate-password.',
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
    if (flags['dev-server-url'] && flags.configuration === 'Release') {
      this.error('--dev-server-url is only supported for Debug builds.');
    }
    if (flags.ios && flags.sdk && DEVICE_SDKS.has(flags.sdk)) {
      this.error(
        '--ios builds run on a simulator. Use --sdk iphonesimulator, --sdk watchsimulator, or omit --sdk.',
      );
    }
    if (flags.ios && hasSigningFlags(flags)) {
      this.error('--ios builds run on a simulator and cannot use signing flags.');
    }

    await this.withAuth(async () => {
      const target =
        flags.ios ?
          await this.resolveSimulatorBackedXcodeTargetOrCreate(flags.id)
        : await this.resolveXcodeTargetOrCreate(flags.id);
      const id = target.id;
      const syncPath = args.path ?? process.cwd();
      const xcodeClient = await this.resolveXcodeClient(target);

      const settings: Record<string, string> = {};
      if (flags.scheme) settings.scheme = flags.scheme;
      if (flags.workspace) settings.workspace = flags.workspace;
      if (flags.project) settings.project = flags.project;
      if (flags.sdk) settings.sdk = flags.sdk;
      if (flags.ios && !flags.sdk) settings.sdk = 'iphonesimulator';
      if (flags.configuration) settings.configuration = flags.configuration;

      const options: XcodeBuildOptions = {};
      if (flags['dev-server-url'] || flags['expo-app-dir']) {
        options.reactNative = {
          ...(flags['expo-app-dir'] && { expoAppDir: flags['expo-app-dir'] }),
          ...(flags['dev-server-url'] && { devServerURL: flags['dev-server-url'] }),
        };
      }
      const appConfig = parseAppConfigEntries(flags['app-config'] ?? []);
      if (appConfig) {
        options.appConfig = appConfig;
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

  private async buildSigningOptions(flags: SigningFlags): Promise<
    | {
        certificateP12Base64: string;
        certificatePassword: string;
        provisioningProfileBase64: string;
      }
    | undefined
  > {
    const hasCertificate = flags['certificate-p12'] !== undefined;
    const hasPassword = flags['certificate-password'] !== undefined;
    const hasProfile = flags['provisioning-profile'] !== undefined;
    if (!hasSigningFlags(flags)) {
      return undefined;
    }
    if (!hasCertificate || !hasPassword || !hasProfile) {
      this.error(
        'Signed device builds require --certificate-p12, --certificate-password, and --provisioning-profile.',
      );
    }

    return {
      certificateP12Base64: (await readFile(flags['certificate-p12']!)).toString('base64'),
      certificatePassword: flags['certificate-password']!,
      provisioningProfileBase64: (await readFile(flags['provisioning-profile']!)).toString('base64'),
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

function hasSigningFlags(flags: SigningFlags): boolean {
  return (
    flags['certificate-p12'] !== undefined ||
    flags['certificate-password'] !== undefined ||
    flags['provisioning-profile'] !== undefined
  );
}
