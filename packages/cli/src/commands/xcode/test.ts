import { secretEnvFlags, secretFileFlags } from '../../lib/secret-env-flags';
import { parseSecretEnv, parseSecretFiles } from '../../lib/secret-env';
import fs from 'fs';
import path from 'path';
import { Args, Flags } from '@oclif/core';
import type { XcodeBuildOptions, XcodeProjectConfig, XctestEvent } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import { formatDurationMs } from '../../lib/duration';
import { formatBytes } from '../../lib/bytes';
import { parseSnapshotConfig } from '../../lib/cache';
import { snapshotFlags } from '../../lib/cache-flags';
import { resolveRequestedXcodeVersion, xcodeVersionFlags } from '../../lib/xcode-version';
import { syncFlags, syncOptionsFromFlags } from '../../lib/sync-flags';
import {
  projectConfigFromFlags,
  xcodegenConfigFromFlags,
  xcodeProjectFlags,
} from '../../lib/xcode-project-flags';
import { formatCaseLine, formatSummaryLine } from '../../lib/xctest-render';
import { IOS_MODELS, IOS_OS_VERSIONS, iosDeviceSelection } from '../../lib/ios-device-selection';

export default class XcodeTest extends BaseCommand {
  static description =
    "Build a scheme's test targets on an Xcode sandbox and run them on an attached iOS simulator, streaming per-case results. Exits non-zero when tests fail. Creates and attaches the instances it needs unless --id points at an existing target.";

  static examples = [
    '$ lim xcode test',
    '$ lim xcode test ./MyProject --scheme MyApp',
    '$ lim xcode test . --only-testing MyAppTests/LoginTests/testValidLogin',
    "$ lim xcode test . --only-testing 'MyAppTests/CartSuite/addsItem()'",
    '$ lim xcode test . --model ipad --os-version 27',
    '$ lim xcode test . --skip-testing MyAppUITests',
    '$ lim xcode test . --json > results.ndjson',
    '$ lim xcode test . --result-bundle Tests.xcresult --coverage',
    '$ lim xcode test --without-building --only-testing MyAppTests/LoginTests --result-bundle Login.xcresult',
  ];

  static args = {
    path: Args.string({
      description: 'Local project path to sync before testing. Defaults to the current working directory.',
    }),
  };

  static flags = {
    ...BaseCommand.permissionFlags,
    ...BaseCommand.baseFlags,
    ...secretEnvFlags,
    ...secretFileFlags,
    id: Flags.string({
      description:
        'Xcode instance ID to test on. Defaults to a simulator-backed target, reused or created with its simulator.',
    }),
    'inactivity-timeout': Flags.string({
      description:
        'Inactivity timeout for the instances created by this run (for example 3s, 1m). Forces fresh instances and cannot be combined with --id.',
    }),
    model: Flags.string({
      description:
        'Device model of the simulator this run creates. Forces fresh instances and cannot be combined with --id, --build-only or --no-create.',
      options: IOS_MODELS.filter((model) => model !== 'watch'),
    }),
    'os-version': Flags.string({
      description:
        'iOS major version of the simulator this run creates. iPhone and iPad run both, iPhone Duo 27. Forces fresh instances and cannot be combined with --id, --build-only or --no-create.',
      options: IOS_OS_VERSIONS,
    }),
    'build-only': Flags.boolean({
      description:
        'Compile the test targets without running them: uses a plain sandbox and skips simulator acquisition. Products stay on the sandbox for a later run. On servers without run suppression, a previously attached simulator still runs the tests.',
      default: false,
    }),
    'only-testing': Flags.string({
      description:
        "Run only these tests, in xcodebuild's -only-testing format: Target[/Class[/method]] for XCTest, Target/Suite[/test()] for Swift Testing. Repeat for multiple. Mutually exclusive with --skip-testing.",
      multiple: true,
      multipleNonGreedy: true,
      exclusive: ['skip-testing'],
    }),
    'skip-testing': Flags.string({
      description:
        "Skip these tests, in xcodebuild's -skip-testing format: Target[/Class[/method]] for XCTest, Target/Suite[/test()] for Swift Testing. Repeat for multiple.",
      multiple: true,
      multipleNonGreedy: true,
    }),
    'result-bundle': Flags.string({
      description:
        "Run the tests through Apple's xcodebuild and write their result bundle (.xcresult) to this local path, which must not exist yet. Written even when tests fail.",
    }),
    coverage: Flags.boolean({
      description:
        'Build with code coverage and collect it into the result bundle. Needs --result-bundle, except with --build-only, which builds instrumented products for a later --without-building run.',
      default: false,
    }),
    'without-building': Flags.boolean({
      description:
        'Rerun the tests the Xcode sandbox last built for testing, without syncing or building. Takes the test selection, --result-bundle and --coverage.',
      default: false,
      // A rerun builds nothing, creates no instance and keeps the Xcode the products were built
      // with, so every build input, creation setting and Xcode choice would be ignored.
      exclusive: [
        'build-only',
        'model',
        'os-version',
        'inactivity-timeout',
        'xcode-version',
        ...Object.keys(xcodeProjectFlags),
        ...Object.keys(syncFlags),
        ...Object.keys(snapshotFlags),
      ],
    }),
    ...xcodeProjectFlags,
    ...xcodeVersionFlags,
    ...syncFlags,
    ...snapshotFlags,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(XcodeTest);
    this.setParsedFlags(flags);
    this.snapshotProjectPath = args.path ?? process.cwd();

    const resultBundle = flags['result-bundle'];
    const withoutBuilding = flags['without-building'];
    // A rerun keeps the Xcode that built the products; switching to the workspace preference drops them.
    const requestedXcode = withoutBuilding ? undefined : resolveRequestedXcodeVersion(flags['xcode-version']);
    if (resultBundle && flags['build-only']) {
      this.error('--result-bundle needs a test run and cannot be combined with --build-only.');
    }
    if (flags.coverage && !resultBundle && !flags['build-only']) {
      this.error(
        withoutBuilding ?
          '--coverage is collected into the result bundle; add --result-bundle.'
        : '--coverage is collected into the result bundle; add --result-bundle, or --build-only to build instrumented products for a later run.',
      );
    }
    // Refused before any work, as xcodebuild refuses it after the run.
    if (resultBundle && fs.existsSync(path.resolve(resultBundle))) {
      this.error(`${resultBundle} already exists; choose a new result bundle path.`);
    }
    // Flags are refused through the flag's exclusive list; a path would be ignored the same way.
    if (withoutBuilding && args.path) {
      this.error('--without-building reruns the tests already built and takes no project path.');
    }
    if (flags.id && flags['inactivity-timeout']) {
      this.error('--inactivity-timeout controls newly created instances and cannot be combined with --id.');
    }
    if (flags.model || flags['os-version']) {
      if (flags.id || flags['build-only'] || flags.create === false) {
        this.error(
          '--model and --os-version choose the simulator this run creates and cannot be combined with --id, --build-only or --no-create.',
        );
      }
      this.autoCreateSimulator = iosDeviceSelection(flags['os-version'], flags.model);
    }

    if (withoutBuilding) {
      // A new sandbox has built nothing, so a rerun never creates one.
      this.existingXcodeSandboxOnly =
        '--without-building reruns the tests a live Xcode sandbox already built, and none is recorded. Pass --id, or run lim xcode test first.';
    }

    // A rerun never replaces a missing sandbox: a new one has nothing built.
    await this.withAuth(
      async () => {
        const target =
          flags['build-only'] ?
            await this.resolveXcodeTargetOrCreate(flags.id)
          : await this.resolveSimulatorBackedXcodeTargetOrCreate(flags.id);
        const id = target.id;
        if (!withoutBuilding) {
          await this.applyBuildCacheToTarget(target, parseSnapshotConfig(flags));
        }
        const xcodeClient = await this.resolveXcodeClientForWork(target, requestedXcode);

        const runFields: XcodeProjectConfig = {
          ...(flags['only-testing']?.length && { onlyTesting: flags['only-testing'] }),
          ...(flags['skip-testing']?.length && { skipTesting: flags['skip-testing'] }),
          ...(resultBundle && { resultBundle: true }),
          ...(flags.coverage && { coverage: true }),
        };
        const settings: XcodeProjectConfig =
          withoutBuilding ?
            { action: 'test-without-building', ...runFields }
          : {
              action: 'build-for-testing',
              sdk: 'iphonesimulator',
              ...(flags['build-only'] && { runTests: false }),
              ...projectConfigFromFlags(flags),
              ...runFields,
            };

        const options: XcodeBuildOptions = {
          envFromSecret: parseSecretEnv(flags['env-from-secret']),
          fileFromSecret: parseSecretFiles(flags['file-from-secret']),
        };
        await this.ensureSecretPermissions(id, options.envFromSecret, options.fileFromSecret);
        const xcodegen = xcodegenConfigFromFlags(flags);
        if (xcodegen) {
          options.xcodegen = xcodegen;
        }

        if (withoutBuilding) {
          this.info(`Rerunning the tests last built on instance ${id}...`);
        } else {
          const syncPath = args.path ?? process.cwd();
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
        }

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

        // Downloaded even when tests failed: the bundle is how a red run is read. A lost bundle
        // is reported after the run's own result, which it never replaces.
        let resultBundlePath: string | undefined;
        let bundleProblem: string | undefined;
        const remoteBundle = result.xctest?.resultBundle;
        if (resultBundle && remoteBundle) {
          try {
            await xcodeClient.pullResultBundle(remoteBundle.path, resultBundle);
            resultBundlePath = path.resolve(resultBundle);
            this.info(
              `Result bundle written to ${resultBundlePath} (${formatBytes(remoteBundle.sizeBytes)} zipped).`,
            );
          } catch (err) {
            bundleProblem = `The result bundle could not be downloaded: ${
              err instanceof Error ? err.message : String(err)
            }`;
          }
        } else if (resultBundle && !result.timedOut) {
          bundleProblem =
            result.exitCode === 0 ?
              // A sandbox that predates result bundles runs the tests without one.
              'The Xcode sandbox sent no result bundle; it may predate result bundles. Create a new sandbox and retry.'
            : 'No result bundle was written.';
        }

        if (json) {
          // timedOut marks a fabricated exit code (lost stream); without it a
          // machine consumer would record a definitive failure for an unknown
          // outcome.
          process.stdout.write(
            JSON.stringify({
              exitCode: result.exitCode,
              ...(resultBundlePath ? { resultBundle: resultBundlePath } : {}),
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
        if (bundleProblem) {
          // A green run without the bundle it was asked for still fails.
          if (result.exitCode === 0) this.error(bundleProblem);
          this.warn(bundleProblem);
        }
        if (result.exitCode !== 0) {
          this.exit(result.exitCode);
        }
      },
      { createReplacement: !withoutBuilding },
    );
  }
}
