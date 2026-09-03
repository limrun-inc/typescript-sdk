import { Args, Flags } from '@oclif/core';
import type { XcodeBuildOptions, XcodeProjectConfig, XctestEvent } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import { formatDurationMs } from '../../lib/duration';
import { formatBytes } from '../../lib/bytes';
import { parseCacheConfig } from '../../lib/cache';
import { cacheFlags } from '../../lib/cache-flags';
import { resolveRequestedXcodeVersion, xcodeVersionFlags } from '../../lib/xcode-version';
import { syncFlags, syncOptionsFromFlags } from '../../lib/sync-flags';
import {
  projectConfigFromFlags,
  xcodegenConfigFromFlags,
  xcodeProjectFlags,
} from '../../lib/xcode-project-flags';
import { formatCaseLine, formatSummaryLine } from '../../lib/xctest-render';

export default class XcodeTest extends BaseCommand {
  static description =
    "Build a scheme's test targets on an Xcode sandbox and run them on an attached iOS simulator, streaming per-case results. Exits non-zero when tests fail. Creates and attaches the instances it needs unless --id points at an existing target.";

  static examples = [
    '$ lim xcode test',
    '$ lim xcode test ./MyProject --scheme MyApp',
    '$ lim xcode test . --only-testing MyAppTests/LoginTests/testValidLogin',
    '$ lim xcode test . --skip-testing MyAppUITests',
    '$ lim xcode test . --json > results.ndjson',
  ];

  static args = {
    path: Args.string({
      description: 'Local project path to sync before testing. Defaults to the current working directory.',
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description:
        'Xcode instance ID to test on. Defaults to a simulator-backed target, reused or created with its simulator.',
    }),
    'inactivity-timeout': Flags.string({
      description:
        'Inactivity timeout for the instances created by this run (for example 3s, 1m). Forces fresh instances and cannot be combined with --id.',
    }),
    'build-only': Flags.boolean({
      description:
        'Compile the test targets without running them: uses a plain sandbox and skips simulator acquisition. Products stay on the sandbox for a later run. On servers without run suppression, a previously attached simulator still runs the tests.',
      default: false,
    }),
    'only-testing': Flags.string({
      description:
        "Run only these tests, in xcodebuild's -only-testing format: Target[/Class[/method]]. Repeat for multiple. Mutually exclusive with --skip-testing.",
      multiple: true,
      multipleNonGreedy: true,
      exclusive: ['skip-testing'],
    }),
    'skip-testing': Flags.string({
      description:
        "Skip these tests, in xcodebuild's -skip-testing format: Target[/Class[/method]]. Repeat for multiple.",
      multiple: true,
      multipleNonGreedy: true,
    }),
    ...xcodeProjectFlags,
    ...xcodeVersionFlags,
    ...syncFlags,
    ...cacheFlags,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(XcodeTest);
    this.setParsedFlags(flags);

    if (flags.id && flags['inactivity-timeout']) {
      this.error('--inactivity-timeout controls newly created instances and cannot be combined with --id.');
    }

    await this.withAuth(async () => {
      const target =
        flags['build-only'] ?
          await this.resolveXcodeTargetOrCreate(flags.id)
        : await this.resolveSimulatorBackedXcodeTargetOrCreate(flags.id);
      const id = target.id;
      await this.applyBuildCacheToTarget(target, parseCacheConfig(flags));
      const syncPath = args.path ?? process.cwd();
      const xcodeClient = await this.resolveXcodeClient(target);
      await this.applyXcodeVersionToClient(xcodeClient, resolveRequestedXcodeVersion(flags['xcode-version']));

      const settings: XcodeProjectConfig = {
        action: 'build-for-testing',
        sdk: 'iphonesimulator',
        ...(flags['build-only'] && { runTests: false }),
        ...projectConfigFromFlags(flags),
        ...(flags['only-testing']?.length && { onlyTesting: flags['only-testing'] }),
        ...(flags['skip-testing']?.length && { skipTesting: flags['skip-testing'] }),
      };

      const options: XcodeBuildOptions = {};
      const xcodegen = xcodegenConfigFromFlags(flags);
      if (xcodegen) {
        options.xcodegen = xcodegen;
      }

      this.info(`Syncing ${syncPath} to instance ${id}...`);
      const syncStart = Date.now();
      const syncResult = await xcodeClient.sync(syncPath, syncOptionsFromFlags(flags));
      const syncedSize =
        syncResult.bytesSent !== undefined ? ` (${formatBytes(syncResult.bytesSent)} sent)` : '';
      this.info(`Sync completed in ${formatDurationMs(Date.now() - syncStart)}${syncedSize}.`);
      this.info(
        flags['build-only'] ? 'Building for testing...' : (
          'Building for testing, then running on the simulator...'
        ),
      );

      let sawCases = false;
      const json = this.isJsonEnabled();
      options.onXctestEvent = (event: XctestEvent) => {
        if (json) {
          process.stdout.write(JSON.stringify(event) + '\n');
          return;
        }
        if (event.type === 'case') {
          if (!sawCases) {
            sawCases = true;
            this.output('');
          }
          this.output(formatCaseLine(event));
        }
      };

      const proc = xcodeClient.xcodebuild(settings, options);

      if (!json) {
        proc.stdout.on('data', (line: string) => process.stdout.write(line + '\n'));
        proc.stderr.on('data', (line: string) => process.stderr.write(line + '\n'));
      }

      const result = await proc;

      if (json) {
        // timedOut marks a fabricated exit code (lost stream); without it a
        // machine consumer would record a definitive failure for an unknown
        // outcome.
        process.stdout.write(
          JSON.stringify({
            exitCode: result.exitCode,
            ...(result.timedOut ? { timedOut: true, incomplete: result.incomplete } : {}),
          }) + '\n',
        );
      } else if (result.xctest) {
        this.output('');
        this.output(formatSummaryLine(result.xctest.summary));
      }
      if (result.timedOut) {
        this.error(`Test run did not complete: ${result.incomplete?.message ?? 'timed out'}`);
      }
      if (result.exitCode !== 0) {
        this.exit(result.exitCode);
      }
    });
  }
}
