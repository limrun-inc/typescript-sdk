import path from 'path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { parseLabels } from '../../lib/formatting';
import { registerCreatedInstance } from '../../lib/config';
import { openInBrowser } from '../../lib/browser';
import { formatSimulatorAttachResult, simulatorAttachJson } from '../../lib/simulator-attach';
import { formatDurationMs } from '../../lib/duration';
import { resolveKeychainEncryptionKey } from '../../lib/keychain-encryption-key';
import { parseDurationSeconds } from '../../lib/duration';
import { startPersistedCaptures } from '../../lib/session-captures';
import { Ios, type SimulatorAttachResult } from '@limrun/api';
import { type IosInstanceCreateParams } from '@limrun/api/resources/ios-instances';

export default class IosCreate extends BaseCommand {
  static summary = 'Create a new iOS instance';
  static description =
    'Create a new cloud iOS simulator instance and wait for it to become ready. You can attach labels, install apps, choose a device model, and optionally create and attach an Xcode sandbox.';

  static examples = [
    '<%= config.bin %> ios create',
    '<%= config.bin %> ios create --rm --model ipad',
    '<%= config.bin %> ios create --jurisdiction us --install-asset my-app.ipa',
    '<%= config.bin %> ios create --keychain keychain/login.tar.gz --encryption-key-stdin < keychain.key',
    '<%= config.bin %> ios create --keychain-url https://example.t3.storage.dev/... --encryption-key <key>',
    '<%= config.bin %> ios create --install ./MyApp.ipa',
    '<%= config.bin %> ios create --install-url https://example.t3.storage.dev/MyApp.ipa?...',
    '<%= config.bin %> ios create --attach <xcode-instance-ID>',
    '<%= config.bin %> ios create --force-bundle-id com.example.myapp',
    '<%= config.bin %> ios create --record --events --app-logs com.example.myapp --persist-ttl 24h',
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
    region: Flags.string({
      description:
        'Deprecated: a region is only a preference and may fall back to other regions when full. Use --jurisdiction to constrain where the instance runs.',
    }),
    jurisdiction: Flags.string({
      description:
        'Jurisdiction the instance must be created in. Unlike --region, this is a hard constraint: creation fails when no region in the jurisdiction has capacity.',
      options: ['us', 'eu', 'as'],
    }),
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
    'install-url': Flags.string({
      description:
        'Signed download URL of an app to install onto the instance after creation. Repeat for multiple URLs.',
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
      description: 'Also create an Xcode sandbox and attach the simulator to it for build and sync workflows',
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
    record: Flags.boolean({
      description:
        'Start a persisted session recording as soon as the instance is ready. It keeps recording until stopped or the instance terminates; list results with `lim ios recordings`.',
      default: false,
    }),
    'app-logs': Flags.string({
      description:
        'Start a persisted app log capture for this bundle ID as soon as the instance is ready, and launch the app so its output is captured. List results with `lim ios app-logs`.',
    }),
    events: Flags.boolean({
      description:
        'Start a persisted event log capture (taps, scrolls, commands) as soon as the instance is ready. List results with `lim ios events`.',
      default: false,
    }),
    'persist-ttl': Flags.string({
      description:
        'How long captures started by --record, --app-logs, and --events are kept, as a duration like 72h or 90m.',
      default: '72h',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosCreate);
    if (flags.region) {
      this.warn(
        '--region is deprecated and only a preference; use --jurisdiction to constrain where it runs.',
      );
    }
    this.setParsedFlags(flags);
    if (flags.attach && flags.xcode) {
      this.error('Use either --attach or --xcode, not both.');
    }
    if (args.xcodeId && !flags.attach) {
      this.error('Xcode target argument requires --attach.');
    }
    const wantsCaptures = flags.record || Boolean(flags['app-logs']) || flags.events;
    // Parsed before the instance is created so a bad TTL fails before billing.
    const captureTtlSeconds = wantsCaptures ? parseDurationSeconds(flags['persist-ttl']) : 0;
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

      // Uploaded files are installed via their signed download URL so the
      // instance can fetch them directly without a server-side name lookup.
      const uploadedAssetUrls: string[] = [];
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
          uploadedAssetUrls.push(asset.signedDownloadUrl);
        }
        this.info(`Successfully uploaded ${flags.install.length} file(s)`);
      }

      const params: IosInstanceCreateParams = {
        wait: true,
        reuseIfExists: flags['reuse-if-exists'] || undefined,
        spec: {},
      };

      const appAssets = [
        ...(flags['install-asset'] || []).map((name) => ({
          kind: 'App' as const,
          source: 'AssetName' as const,
          assetName: name,
        })),
        ...[...(flags['install-url'] || []), ...uploadedAssetUrls].map((url) => ({
          kind: 'App' as const,
          source: 'URL' as const,
          url,
        })),
      ];
      if (appAssets.length > 0) {
        params.spec!.initialAssets = appAssets;
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
      if (flags.jurisdiction) params.spec!.jurisdiction = flags.jurisdiction as 'us' | 'eu' | 'as';
      if (flags.model) params.spec!.model = flags.model as 'iphone' | 'ipad' | 'watch';
      if (flags['hard-timeout']) params.spec!.hardTimeout = flags['hard-timeout'];
      if (flags['inactivity-timeout']) params.spec!.inactivityTimeout = flags['inactivity-timeout'];
      if (flags['force-bundle-id']) params.spec!.forceBundleId = flags['force-bundle-id'];

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
      registerCreatedInstance(instance);

      if (wantsCaptures) {
        if (!instance.status.apiUrl) {
          this.error(`Instance ${instance.metadata.id} has no apiUrl yet, cannot start captures.`);
        }
        const captureClient = await Ios.createInstanceClient({
          apiUrl: instance.status.apiUrl,
          token: instance.status.token,
        });
        try {
          const started = await startPersistedCaptures(captureClient, {
            record: flags.record,
            appLogsBundleId: flags['app-logs'],
            events: flags.events,
            ttlSeconds: captureTtlSeconds,
          });
          for (const capture of started) {
            this.info(`Started persisted ${capture} (kept for ${flags['persist-ttl']}).`);
          }
          if (flags['app-logs']) {
            // On iOS only apps launched through limulator's own launch path
            // feed the app log capture, so launch the bundle like the console
            // app picker does. Apps opened by tapping in the stream produce
            // no captured lines.
            try {
              await captureClient.launchApp(flags['app-logs'], { mode: 'RelaunchIfRunning' });
              this.info(`Launched ${flags['app-logs']} to feed the app log capture.`);
            } catch (e) {
              this.warn(
                `Could not launch ${flags['app-logs']}: ${e instanceof Error ? e.message : e}. ` +
                  'The app log capture stays empty until the app is launched with `lim ios launch-app`.',
              );
            }
          }
        } finally {
          captureClient.disconnect();
        }
      }
      let createdXcode: Awaited<ReturnType<typeof this.client.xcodeInstances.create>> | undefined;
      const cleanup = async () => {
        try {
          await this.client.iosInstances.delete(instance.metadata.id);
          this.info(`${instance.metadata.id} is deleted`);
        } catch (e) {
          this.info(`Failed to delete instance: ${e}`);
        }
        if (createdXcode) {
          try {
            await this.client.xcodeInstances.delete(createdXcode.metadata.id);
            this.info(`${createdXcode.metadata.id} is deleted`);
          } catch (e) {
            this.info(`Failed to delete instance: ${e}`);
          }
        }
      };
      let attachResult: SimulatorAttachResult | undefined;
      let attachDurationMs: number | undefined;
      let attachedXcodeId: string | undefined;
      if (attachClient && attachTarget) {
        try {
          const attachStart = Date.now();
          attachResult = await attachClient.attachSimulator(instance);
          attachDurationMs = Date.now() - attachStart;
          attachedXcodeId = attachTarget.id;
        } catch (err) {
          this.info(`Created iOS instance ${instance.metadata.id}, but attach failed.`);
          if (flags.rm) {
            await cleanup();
          }
          throw err;
        }
      } else if (flags.xcode) {
        try {
          createdXcode = await this.client.xcodeInstances.create({
            wait: true,
            reuseIfExists: flags['reuse-if-exists'] || undefined,
            ...(params.metadata ? { metadata: params.metadata } : {}),
            spec: {
              ...(flags.region ? { region: flags.region } : {}),
              ...(flags.jurisdiction ? { jurisdiction: flags.jurisdiction as 'us' | 'eu' | 'as' } : {}),
              ...(flags['hard-timeout'] ? { hardTimeout: flags['hard-timeout'] } : {}),
              ...(flags['inactivity-timeout'] ? { inactivityTimeout: flags['inactivity-timeout'] } : {}),
            },
          });
          registerCreatedInstance(createdXcode);
          const xcodeClient = await this.client.xcodeInstances.createClient({ instance: createdXcode });
          const attachStart = Date.now();
          attachResult = await xcodeClient.attachSimulator(instance);
          attachDurationMs = Date.now() - attachStart;
          attachedXcodeId = createdXcode.metadata.id;
        } catch (err) {
          this.info(
            `Created iOS instance ${instance.metadata.id}, but creating or attaching an Xcode sandbox failed.`,
          );
          // The sandbox is useless without the attach; never leak a billed
          // one. Reuse only matches this command's own labels, so a reused
          // instance is part of the same workflow and fine to delete too.
          if (createdXcode) {
            await this.client.xcodeInstances.delete(createdXcode.metadata.id).catch(() => {});
            createdXcode = undefined;
          }
          if (flags.rm) {
            await cleanup();
          }
          throw err;
        }
      }
      const createdMessage =
        flags.xcode ?
          `Created a new iOS instance with an attached Xcode sandbox in ${formatDurationMs(
            createDurationMs,
          )}.`
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
      if (createdXcode) {
        this.info('Xcode Instance:');
        this.info(`  ID: ${createdXcode.metadata.id}`);
        if (createdXcode.status.apiUrl) {
          this.info(`  URL: ${createdXcode.status.apiUrl}`);
        }
      }
      if (attachResult && attachedXcodeId) {
        if (attachDurationMs !== undefined) {
          this.info(`Attach/install completed in ${formatDurationMs(attachDurationMs)}.`);
        }
        this.info(formatSimulatorAttachResult(instance.metadata.id, attachedXcodeId, attachResult));
      }

      if (flags.open && signedStreamUrl && !this.shouldSuppressInfo()) {
        if (await openInBrowser(signedStreamUrl)) {
          this.info('Opened the stream in your browser.');
        }
      }

      if (flags.json) {
        if (attachResult && attachedXcodeId) {
          this.outputJson({
            ...instance,
            ...(createdXcode ? { xcode: createdXcode } : {}),
            attach: simulatorAttachJson(instance.metadata.id, attachedXcodeId, attachResult),
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
