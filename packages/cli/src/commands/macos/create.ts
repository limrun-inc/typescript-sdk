import { Flags } from '@oclif/core';
import { type MacosInstanceCreateParams } from '@limrun/api/resources/macos-instances';
import { BaseCommand } from '../../base-command';
import { createdInstanceOutput } from '../../lib/create-output';
import { delegatedPermissionsFromFlags } from '../../lib/delegated-permissions';
import { registerCreatedInstance } from '../../lib/config';
import { parseLabels } from '../../lib/formatting';
import { parseSnapshotConfig } from '../../lib/cache';
import { macosSnapshotPermissions, restoreMacosSnapshot } from '../../lib/macos-snapshot';
import { macosSnapshotFlags } from '../../lib/cache-flags';
import { startPersistedCaptures } from '../../lib/session-captures';
import { parseDurationSeconds } from '../../lib/duration';

export default class MacosCreate extends BaseCommand {
  static summary = 'Create a new macOS instance';
  static description =
    'Create a macOS virtual machine in the cloud and wait until it is ready. Open it in the console to see and control its desktop.';

  static examples = [
    '<%= config.bin %> macos create',
    '<%= config.bin %> macos create --jurisdiction eu',
    '<%= config.bin %> macos create --label env=dev --display-name review-mac --inactivity-timeout 30m',
    '<%= config.bin %> macos create --snapshot-key my-mac --snapshot-restore-keys "my-mac,base-mac"',
    '<%= config.bin %> macos create --tunnel staging',
    '<%= config.bin %> macos create --record --events --perf --persist-ttl 24h',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    ...BaseCommand.permissionFlags,
    ...macosSnapshotFlags,
    'display-name': Flags.string({
      description: 'Human-friendly display name shown in listings and the console',
    }),
    jurisdiction: Flags.string({
      description:
        'Jurisdiction the instance must be created in. Creation fails when no region in the jurisdiction has capacity.',
      options: ['us', 'eu', 'as'],
    }),
    'hard-timeout': Flags.string({
      description: "Hard timeout (e.g. 1m, 10m, 3h). Default: the organization's macOS default",
    }),
    'inactivity-timeout': Flags.string({
      description: "Inactivity timeout (e.g. 1m, 10m, 3h). Default: the organization's macOS default",
    }),
    record: Flags.boolean({
      description:
        'Start a persisted screen recording as soon as the instance is ready. It keeps recording until stopped or the instance terminates; list results with `lim macos recordings`.',
      default: false,
    }),
    'app-logs': Flags.string({
      description:
        "Start a persisted capture of this bundle ID's log as soon as the instance is ready; it records the app whenever it runs. List results with `lim macos app-logs`.",
    }),
    events: Flags.boolean({
      description:
        'Start a persisted event log capture (clicks, scrolls and keys sent to the screen) as soon as the instance is ready. List results with `lim macos events`.',
      default: false,
    }),
    perf: Flags.boolean({
      description:
        'Save the CPU and memory of the running apps, sampled once a second, from the moment the instance is ready. List results with `lim macos perf-captures`; read live figures any time with `lim macos perf`.',
      default: false,
    }),
    'persist-ttl': Flags.string({
      description:
        'How long captures started by --record, --app-logs, --events, and --perf are kept, as a duration like 72h or 90m.',
      default: '72h',
    }),
    tunnel: Flags.string({
      description:
        'Name of a private tunnel, created in the console (Network) and run with lim tunnel run, that the ' +
        'instance must attach to before it becomes ready.',
    }),
    label: Flags.string({
      description: 'Metadata label in key=value format. Repeat to attach multiple labels.',
      multiple: true,
    }),
    'reuse-if-exists': Flags.boolean({
      description: 'Reuse an existing instance with matching labels; its permissions remain unchanged',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(MacosCreate);
    this.setParsedFlags(flags);
    // A macOS snapshot is an asset: the instance's role grants it, and the CLI restores it once the
    // instance is ready and names the key the instance saves under at termination.
    const snapshot = parseSnapshotConfig({
      'snapshot-key': flags['snapshot-key'],
      'snapshot-restore-keys': flags['snapshot-restore-keys'],
    });
    if (snapshot && flags['reuse-if-exists']) {
      this.info('A reused instance keeps the permissions it was created with, and its disk is not restored.');
    }
    const wantsCaptures = flags.record || Boolean(flags['app-logs']) || flags.events || flags.perf;
    // Parsed before the instance is created so a bad TTL fails before billing.
    const captureTtlSeconds = wantsCaptures ? parseDurationSeconds(flags['persist-ttl']) : 0;

    await this.withAuth(async () => {
      const labels = parseLabels(flags.label);
      const metadata = {
        ...(flags['display-name'] && { displayName: flags['display-name'] }),
        ...(labels && { labels }),
      };
      const delegatedPermissions = delegatedPermissionsFromFlags(this.parsedFlags ?? {});
      const params: MacosInstanceCreateParams = {
        wait: true,
        reuseIfExists: flags['reuse-if-exists'] || undefined,
        spec: {
          role: {
            permissions: [
              ...(delegatedPermissions ?? []),
              ...(snapshot ? macosSnapshotPermissions(snapshot) : []),
            ],
          },
          ...(flags.jurisdiction && { jurisdiction: flags.jurisdiction as 'us' | 'eu' | 'as' }),
          ...(flags['hard-timeout'] && { hardTimeout: flags['hard-timeout'] }),
          ...(flags['inactivity-timeout'] && { inactivityTimeout: flags['inactivity-timeout'] }),
          ...(flags.tunnel && { tunnel: flags.tunnel }),
        },
        ...(Object.keys(metadata).length > 0 && { metadata }),
      };
      const requestedAt = Date.now();
      const instance = await this.client.macosInstances.create(params);
      const consoleUrl = this.consoleStreamUrl(instance.metadata.id);
      registerCreatedInstance(instance);

      if (snapshot || wantsCaptures) {
        const guest = await this.client.macosInstances.createClient({ instance, logLevel: 'none' });
        if (snapshot) {
          // A reused instance already holds its own work on disk; a restore would overwrite it.
          if (flags['reuse-if-exists'] && wasCreatedBefore(instance.metadata.createdAt, requestedAt)) {
            this.info(
              `Reused macOS instance ${instance.metadata.id}; its disk is kept and no snapshot is restored.`,
            );
          } else {
            await restoreMacosSnapshot(guest, snapshot, (line) => this.info(line));
          }
        }
        if (wantsCaptures) {
          const started = await startPersistedCaptures(guest, {
            record: flags.record,
            appLogsBundleId: flags['app-logs'],
            events: flags.events,
            ttlSeconds: captureTtlSeconds,
          });
          if (flags.perf) {
            await guest.startPerformanceCapture({ ttlSeconds: captureTtlSeconds });
            started.push('performance capture');
          }
          for (const capture of started) {
            this.info(`Started persisted ${capture} (kept for ${flags['persist-ttl']}).`);
          }
        }
      }

      if (flags.json) {
        this.outputJson(createdInstanceOutput(instance, consoleUrl));
        return;
      }
      this.output(`Created macOS instance: ${instance.metadata.id}`);
      this.output(`Console URL: ${consoleUrl}`);
      this.output(`Region: ${instance.spec.region}`);
      this.output(`Delete with: lim macos delete ${instance.metadata.id}`);
    });
  }
}

/** Clock skew allowed between this machine and the API when telling a reused instance from a new one. */
const CLOCK_SKEW_MS = 5000;

/**
 * wasCreatedBefore reports whether an instance existed before this command asked for one. An
 * instance whose age can't be read is treated as reused, so a restore never overwrites a live disk.
 */
function wasCreatedBefore(createdAt: string | undefined, requestedAt: number): boolean {
  const created = createdAt ? Date.parse(createdAt) : NaN;
  return !(created >= requestedAt - CLOCK_SKEW_MS);
}
