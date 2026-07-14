import path from 'path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { parseLabels } from '../../lib/formatting';
import { registerCreatedInstance } from '../../lib/config';
import { openInBrowser } from '../../lib/browser';
import { xcodeSandboxIdFromUrl } from '../../lib/xcode-sandbox';
import { formatSimulatorAttachResult, simulatorAttachJson } from '../../lib/simulator-attach';
import { formatDurationMs } from '../../lib/duration';
import { resolveKeychainEncryptionKey } from '../../lib/keychain-encryption-key';
import { type SimulatorAttachResult } from '@limrun/api';
import { type IosInstanceCreateParams } from '@limrun/api/resources/ios-instances';

export default class IosCreate extends BaseCommand {
  static summary = 'Create a new iOS instance';
  static description =
    'Create a new cloud iOS simulator instance and wait for it to become ready. You can attach labels, install apps, choose a device model, and optionally enable an Xcode sandbox.';

  static examples = [
    '<%= config.bin %> ios create',
    '<%= config.bin %> ios create --rm --model ipad',
    '<%= config.bin %> ios create --region us-west --install-asset my-app.ipa',
    '<%= config.bin %> ios create --keychain keychain/login.tar.gz --encryption-key-stdin < keychain.key',
    '<%= config.bin %> ios create --keychain-url https://example.t3.storage.dev/... --encryption-key <key>',
    '<%= config.bin %> ios create --install ./MyApp.ipa',
    '<%= config.bin %> ios create --attach <xcode-instance-ID>',
    '<%= config.bin %> ios create --force-bundle-id com.example.myapp',
  ];

  static args = {
    xcodeId: Args.string({
      description: 'Xcode target to attach to. Defaults to the most recently created Xcode target.',
      required: false,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    rm: Flags.boolean({
      description: 'Delete the instance automatically when this CLI process exits',
      default: false,
    }),
    'display-name': Flags.string({
      description: 'Human-friendly display name shown in listings and the console',
    }),
    region: Flags.string({ description: 'Region where the instance should be created, such as us-west' }),
    'hard-timeout': Flags.string({ description: 'Hard timeout (e.g. 1m, 10m, 3h). Default: no timeout' }),
    'inactivity-timeout': Flags.string({
      description: 'Inactivity timeout (e.g. 1m, 10m, 3h). Default is in organization settings.',
    }),
    'force-bundle-id': Flags.string({
      description: 'Lock the simulator to this app after it first enters the foreground',
    }),
    label: Flags.string({
      description: 'Metadata label in key=value format. Repeat to attach multiple labels.',
      multiple: true,
    }),
    model: Flags.string({
      description: 'Device model to create',
      options: ['iphone', 'ipad', 'watch'],
    }),
    'reuse-if-exists': Flags.boolean({
      description: 'Reuse an existing matching instance instead of creating a new one',
      default: false,
    }),
    'install-asset': Flags.string({
      description: 'Existing asset name to install onto the instance after creation',
      multiple: true,
    }),
    keychain: Flags.string({
      description: 'Existing encrypted Keychain asset name to restore after creation.',
      multiple: true,
    }),
    'keychain-url': Flags.string({
      description: 'Presigned encrypted Keychain asset URL to restore after creation.',
      multiple: true,
    }),
    'encryption-key': Flags.string({
      description: 'Base64/base64url 32-byte decryption key for --keychain/--keychain-url.',
    }),
    'encryption-key-stdin': Flags.boolean({
      description:
        'Read the base64/base64url 32-byte decryption key for --keychain/--keychain-url from stdin.',
      default: false,
    }),
    install: Flags.string({
      description:
        'Local app file to upload and install automatically after creation. Repeat for multiple files.',
      multiple: true,
    }),
    'asset-ttl': Flags.string({
      description:
        'Asset time-to-live for files uploaded via --install, as a Go duration (e.g. "24h", min 1m). Does not affect --install-asset. Defaults to no expiry.',
    }),
    xcode: Flags.boolean({
      description: 'Enable an attached Xcode sandbox for build and sync workflows',
      default: false,
    }),
    attach: Flags.boolean({
      description: 'Attach the created simulator to an existing Xcode target',
      default: false,
    }),
    open: Flags.boolean({
      description:
        'Open the signed stream URL in your browser once the instance is ready. Use --no-open to skip.',
      default: true,
      allowNo: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosCreate);
    this.setParsedFlags(flags);
    if (flags.attach && flags.xcode) {
      this.error('Use either --attach or --xcode, not both.');
    }
    if (args.xcodeId && !flags.attach) {
      this.error('Xcode target argument requires --attach.');
    }
    const hasKeychainInitialAssets = Boolean(flags.keychain?.length || flags['keychain-url']?.length);
    if (!hasKeychainInitialAssets && (flags['encryption-key'] || flags['encryption-key-stdin'])) {
      this.error('Use --encryption-key or --encryption-key-stdin only with --keychain or --keychain-url.');
    }

    let keychainEncryptionKey: string | undefined;
    if (hasKeychainInitialAssets) {
      try {
        keychainEncryptionKey = await resolveKeychainEncryptionKey({
          encryptionKey: flags['encryption-key'],
          encryptionKeyStdin: flags['encryption-key-stdin'],
        });
      } catch (error) {
        this.error((error as Error).message);
      }
    }

    await this.withAuth(async () => {
      const attachTarget = flags.attach ? await this.resolveXcodeTarget(args.xcodeId) : undefined;
      if (attachTarget && attachTarget.type !== 'xcode') {
        this.error(
          '--attach requires a standalone Xcode instance. Create one with `lim xcode create`, then rerun with its ID.',
        );
      }
      const attachClient = attachTarget ? await this.resolveXcodeClient(attachTarget) : undefined;

      const assetNames: string[] = [...(flags['install-asset'] || [])];
      if (flags.install) {
        for (const filePath of flags.install) {
          const resolved = path.resolve(filePath);
          const name = path.basename(resolved);
          this.info(`Uploading ${name}...`);
          const asset = await this.client.assets.getOrUpload({
            path: resolved,
            name,
            ttl: flags['asset-ttl'],
          });
          assetNames.push(asset.name);
        }
        this.info(`Successfully uploaded ${flags.install.length} file(s)`);
      }

      const params: IosInstanceCreateParams = {
        wait: true,
        reuseIfExists: flags['reuse-if-exists'] || undefined,
        spec: {},
      };

      if (assetNames.length > 0) {
        params.spec!.initialAssets = assetNames.map((name) => ({
          kind: 'App' as const,
          source: 'AssetName' as const,
          assetName: name,
        }));
      }
      if (hasKeychainInitialAssets) {
        const encryptionKey = keychainEncryptionKey!;
        if (!params.spec) params.spec = {};
        params.spec!.initialAssets = [
          ...(params.spec!.initialAssets || []),
          ...(flags.keychain || []).map((name) => ({
            kind: 'Keychain' as const,
            source: 'AssetName' as const,
            assetName: name,
            encryptionKey,
          })),
          ...(flags['keychain-url'] || []).map((url) => ({
            kind: 'Keychain' as const,
            source: 'URL' as const,
            url,
            encryptionKey,
          })),
        ];
      }

      if (flags.region) params.spec!.region = flags.region;
      if (flags.model) params.spec!.model = flags.model as 'iphone' | 'ipad' | 'watch';
      if (flags['hard-timeout']) params.spec!.hardTimeout = flags['hard-timeout'];
      if (flags['inactivity-timeout']) params.spec!.inactivityTimeout = flags['inactivity-timeout'];
      if (flags['force-bundle-id']) params.spec!.forceBundleId = flags['force-bundle-id'];
      if (flags.xcode) {
        params.spec!.sandbox = { xcode: { enabled: true } };
      }

      const labels = parseLabels(flags.label);
      if (flags['display-name'] || labels) {
        params.metadata = {};
        if (flags['display-name']) params.metadata.displayName = flags['display-name'];
        if (labels) params.metadata.labels = labels;
      }

      const createStart = Date.now();
      const instance = await this.client.iosInstances.create(params);
      const createDurationMs = Date.now() - createStart;
      const consoleUrl = this.consoleStreamUrl(instance.metadata.id);
      const signedStreamUrl = this.signedStreamUrl(instance.status);
      const xcodeSandboxUrl = instance.status.sandbox?.xcode?.url;
      const xcodeSandboxId = xcodeSandboxUrl ? xcodeSandboxIdFromUrl(xcodeSandboxUrl) : undefined;
      registerCreatedInstance(instance, flags.xcode ? ['xcode'] : []);
      const cleanup = async () => {
        try {
          await this.client.iosInstances.delete(instance.metadata.id);
          this.info(`${instance.metadata.id} is deleted`);
        } catch (e) {
          this.info(`Failed to delete instance: ${e}`);
        }
      };
      let attachResult: SimulatorAttachResult | undefined;
      let attachDurationMs: number | undefined;
      if (attachClient) {
        try {
          const attachStart = Date.now();
          attachResult = await attachClient.attachSimulator(instance);
          attachDurationMs = Date.now() - attachStart;
        } catch (err) {
          this.info(`Created iOS instance ${instance.metadata.id}, but attach failed.`);
          if (flags.rm) {
            await cleanup();
          }
          throw err;
        }
      }
      const createdMessage =
        flags.xcode ?
          `Created a new iOS instance with Xcode sandbox in ${formatDurationMs(createDurationMs)}.`
        : `Created a new iOS instance in ${formatDurationMs(createDurationMs)}.`;
      this.info(createdMessage);
      this.info('iOS Instance:');
      this.info(`  ID: ${instance.metadata.id}`);
      this.info(`  Console URL: ${consoleUrl}`);
      if (signedStreamUrl) {
        this.info(`  Signed Stream URL: ${signedStreamUrl}`);
      }
      this.info(`  Region: ${instance.spec.region}`);
      this.info(`  State: ${instance.status.state}`);
      if (xcodeSandboxUrl) {
        this.info('Xcode Sandbox:');
        if (xcodeSandboxId) {
          this.info(`  ID: ${xcodeSandboxId}`);
        }
        this.info(`  URL: ${xcodeSandboxUrl}`);
      }
      if (attachResult && attachTarget) {
        if (attachDurationMs !== undefined) {
          this.info(`Attach/install completed in ${formatDurationMs(attachDurationMs)}.`);
        }
        this.info(formatSimulatorAttachResult(instance.metadata.id, attachTarget.id, attachResult));
      }

      if (flags.open && signedStreamUrl && !this.shouldSuppressInfo()) {
        if (await openInBrowser(signedStreamUrl)) {
          this.info('Opened the stream in your browser.');
        }
      }

      if (flags.json) {
        if (attachResult && attachTarget) {
          this.outputJson({
            ...instance,
            attach: simulatorAttachJson(instance.metadata.id, attachTarget.id, attachResult),
          });
        } else {
          this.outputJson(instance);
        }
      } else if (this.isQuietEnabled()) {
        this.output(instance.metadata.id);
      }

      if (flags.rm) {
        this.info('Instance running. Press Ctrl+C to stop and delete.');
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
