import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { parseLabels } from '../../lib/formatting';
import { registerCreatedInstance } from '../../lib/config';
import { formatSimulatorAttachResult, simulatorAttachJson } from '../../lib/simulator-attach';
import { parseCacheConfig, wantsRestore } from '../../lib/cache';
import { wasFreshlyCreated } from '../../lib/instance-cleanup';
import { cacheFlags } from '../../lib/cache-flags';
import { type SimulatorAttachResult, type XcodeInstanceCreateParamsWithCache } from '@limrun/api';
import { type IosInstanceCreateParams } from '@limrun/api/resources/ios-instances';

export default class XcodeCreate extends BaseCommand {
  static summary = 'Create a new Xcode instance';
  static description =
    'Create a new cloud Xcode sandbox for remote sync and build workflows. Use `--ios` to also create a fresh iOS simulator and attach it, or `--attach` to attach an existing one.';

  static examples = [
    '<%= config.bin %> xcode create',
    '<%= config.bin %> xcode create --ios',
    '<%= config.bin %> xcode create --attach --simulator-id <ios-instance-ID>',
    '<%= config.bin %> xcode create --rm --jurisdiction us',
    '<%= config.bin %> xcode create --label env=dev --display-name ci-builder',
    '<%= config.bin %> xcode create --cache-restore-keys "myapp-features,myapp-main"',
    '<%= config.bin %> xcode create --cache-key myapp-pr51 --cache-paths "Pods,.build"',
  ];

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
        'Deprecated: a region is only a preference and may fall back to other regions when full. Use --jurisdiction to constrain where the sandbox runs.',
    }),
    jurisdiction: Flags.string({
      description:
        'Jurisdiction the sandbox must be created in. Unlike --region, this is a hard constraint: creation fails when no region in the jurisdiction has capacity.',
      options: ['us', 'eu', 'as'],
    }),
    'hard-timeout': Flags.string({ description: 'Hard timeout (e.g. 1m, 10m, 3h). Default: no timeout' }),
    'inactivity-timeout': Flags.string({
      description: 'Inactivity timeout (e.g. 1m, 10m, 3h). Default is in organization settings.',
    }),
    label: Flags.string({
      description: 'Metadata label in key=value format. Repeat to attach multiple labels.',
      multiple: true,
    }),
    'reuse-if-exists': Flags.boolean({
      description: 'Reuse an existing matching instance instead of creating a new one',
      default: false,
    }),
    ios: Flags.boolean({
      description: 'Also create a fresh iOS simulator and attach it to the created Xcode instance',
      default: false,
    }),
    attach: Flags.boolean({
      description: 'Attach an existing iOS simulator to the created standalone Xcode instance',
      default: false,
    }),
    'simulator-id': Flags.string({
      description: 'Existing iOS simulator instance ID to attach when --attach is used',
    }),
    ...cacheFlags,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(XcodeCreate);
    if (flags.region) {
      this.warn(
        '--region is deprecated and only a preference; use --jurisdiction to constrain where it runs.',
      );
    }
    this.setParsedFlags(flags);
    if (flags.attach && flags.ios) {
      this.error('Use either --attach or --ios, not both.');
    }
    if (flags.attach && !flags['simulator-id']) {
      this.error('--attach requires --simulator-id.');
    }
    if (flags['simulator-id'] && !flags.attach) {
      this.error('--simulator-id requires --attach.');
    }

    const cache = parseCacheConfig(flags);
    if (cache && flags['reuse-if-exists']) {
      this.info('A reused instance keeps the cache configuration it was created with.');
    }

    await this.withAuth(async () => {
      const labels = parseLabels(flags.label);
      const simulator = flags.attach ? await this.client.iosInstances.get(flags['simulator-id']!) : undefined;

      const params: XcodeInstanceCreateParamsWithCache = {
        wait: true,
        reuseIfExists: flags['reuse-if-exists'] || undefined,
        spec: { ...(cache ? { cache } : {}) },
      };

      if (flags.region) params.spec!.region = flags.region;
      if (flags.jurisdiction) params.spec!.jurisdiction = flags.jurisdiction as 'us' | 'eu' | 'as';
      if (flags['hard-timeout']) params.spec!.hardTimeout = flags['hard-timeout'];
      if (flags['inactivity-timeout']) params.spec!.inactivityTimeout = flags['inactivity-timeout'];

      if (flags['display-name'] || labels) {
        params.metadata = {};
        if (flags['display-name']) params.metadata.displayName = flags['display-name'];
        if (labels) params.metadata.labels = labels;
      }

      const start = Date.now();
      const instance = await this.client.xcodeInstances.create(params);
      const consoleUrl = this.consoleStreamUrl(instance.metadata.id);
      const signedStreamUrl = this.signedStreamUrl(
        instance.status as { signedStreamUrl?: string } | undefined,
      );
      registerCreatedInstance(instance);
      const cleanup = async () => {
        try {
          await this.client.xcodeInstances.delete(instance.metadata.id);
          this.info(`${instance.metadata.id} is deleted`);
        } catch (e) {
          this.info(`Failed to delete instance: ${e}`);
        }
        if (createdSimulator && attachedSimulator) {
          try {
            await this.client.iosInstances.delete(attachedSimulator.metadata.id);
            this.info(`${attachedSimulator.metadata.id} is deleted`);
          } catch (e) {
            this.info(`Failed to delete instance: ${e}`);
          }
        }
      };
      let attachResult: SimulatorAttachResult | undefined;
      let attachedSimulator = simulator;
      let createdSimulator = false;
      if (flags.ios) {
        try {
          const xcodeClient = await this.client.xcodeInstances.createClient({ instance });
          const simParams: IosInstanceCreateParams = {
            wait: true,
            reuseIfExists: flags['reuse-if-exists'] || undefined,
            spec: {},
          };
          if (flags.region) simParams.spec!.region = flags.region;
          if (flags.jurisdiction) simParams.spec!.jurisdiction = flags.jurisdiction as 'us' | 'eu' | 'as';
          if (flags['hard-timeout']) simParams.spec!.hardTimeout = flags['hard-timeout'];
          if (flags['inactivity-timeout']) simParams.spec!.inactivityTimeout = flags['inactivity-timeout'];
          if (flags['display-name'] || labels) {
            simParams.metadata = {};
            if (flags['display-name']) simParams.metadata.displayName = flags['display-name'];
            if (labels) simParams.metadata.labels = labels;
          }
          const simCreateStart = Date.now();
          attachedSimulator = await this.client.iosInstances.create(simParams);
          createdSimulator = true;
          try {
            attachResult = await xcodeClient.attachSimulator(attachedSimulator);
          } catch (err) {
            // A freshly created simulator is useless without the attach, so it
            // must not leak; one that reuseIfExists matched belongs to the user.
            if (wasFreshlyCreated(attachedSimulator.metadata.createdAt, simCreateStart)) {
              await this.client.iosInstances.delete(attachedSimulator.metadata.id).catch(() => {});
            }
            attachedSimulator = undefined;
            createdSimulator = false;
            throw err;
          }
        } catch (err) {
          this.info(
            `Created Xcode instance ${instance.metadata.id}, but creating or attaching a simulator failed.`,
          );
          if (flags.rm) {
            await cleanup();
          }
          throw err;
        }
      } else if (flags.attach && simulator) {
        try {
          const xcodeClient = await this.client.xcodeInstances.createClient({ instance });
          attachResult = await xcodeClient.attachSimulator(simulator);
        } catch (err) {
          this.info(`Created Xcode instance ${instance.metadata.id}, but attach failed.`);
          if (flags.rm) {
            await cleanup();
          }
          throw err;
        }
      }
      this.info(`Created a new Xcode instance in ${((Date.now() - start) / 1000).toFixed(1)}s`);
      this.info('Xcode Instance:');
      this.info(`  ID: ${instance.metadata.id}`);
      this.info(`  Console URL: ${consoleUrl}`);
      if (signedStreamUrl) {
        this.info(`  Signed Stream URL: ${signedStreamUrl}`);
      }
      this.info(`  Region: ${instance.spec.region}`);
      this.info(`  State: ${instance.status.state}`);
      if (attachedSimulator) {
        registerCreatedInstance(attachedSimulator);
        if (createdSimulator) {
          const simStreamUrl = this.signedStreamUrl(attachedSimulator.status);
          this.info('iOS Simulator:');
          this.info(`  ID: ${attachedSimulator.metadata.id}`);
          if (simStreamUrl) {
            this.info(`  Signed Stream URL: ${simStreamUrl}`);
          }
        }
        if (attachResult) {
          this.info(
            formatSimulatorAttachResult(attachedSimulator.metadata.id, instance.metadata.id, attachResult),
          );
        }
      }

      if (wantsRestore(cache)) {
        await this.awaitCacheRestore(instance.metadata.id, cleanup);
      }

      if (flags.json) {
        if (attachResult && attachedSimulator) {
          this.outputJson({
            ...instance,
            ...(createdSimulator ? { simulator: attachedSimulator } : {}),
            attach: simulatorAttachJson(attachedSimulator.metadata.id, instance.metadata.id, attachResult),
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
