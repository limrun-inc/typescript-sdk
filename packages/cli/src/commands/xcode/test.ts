import { Args, Flags } from '@oclif/core';
import type { XcodeBuildOptions, XctestEvent, XctestSummaryEvent } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import { compileIgnorePatterns } from '../../lib/ignore-patterns';
import { formatDurationMs } from '../../lib/duration';
import { formatBytes } from '../../lib/bytes';
import { parseCacheConfig } from '../../lib/cache';
import { cacheFlags } from '../../lib/cache-flags';
import { parseAdditionalFileFlags } from '../../lib/additional-files';
import { syncFlags } from '../../lib/sync-flags';
import { xcodeProjectFlags } from '../../lib/xcode-project-flags';
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
        'Compile the test targets without running them: uses a plain sandbox and skips simulator acquisition. Products stay on the sandbox for a later run.',
      default: false,
    }),
    'only-testing': Flags.string({
      description:
        "Run only these tests, in xcodebuild's -only-testing format: Target[/Class[/method]]. Repeat for multiple. Mutually exclusive with --skip-testing.",
      multiple: true,
      multipleNonGreedy: true,
    }),
    'skip-testing': Flags.string({
      description:
        "Skip these tests, in xcodebuild's -skip-testing format: Target[/Class[/method]]. Repeat for multiple.",
      multiple: true,
      multipleNonGreedy: true,
    }),
    ...xcodeProjectFlags,
    ...syncFlags,
    ...cacheFlags,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(XcodeTest);
    this.setParsedFlags(flags);

    if (flags['only-testing']?.length && flags['skip-testing']?.length) {
      this.error('--only-testing and --skip-testing are mutually exclusive; pass one.');
    }
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

      const settings: Record<string, string | string[]> = {
        action: 'build-for-testing',
        sdk: 'iphonesimulator',
      };
      if (flags.scheme) settings.scheme = flags.scheme;
      if (flags.workspace) settings.workspace = flags.workspace;
      if (flags.project) settings.project = flags.project;
      if (flags.configuration) settings.configuration = flags.configuration;
      if (flags['only-testing']?.length) settings.onlyTesting = flags['only-testing'];
      if (flags['skip-testing']?.length) settings.skipTesting = flags['skip-testing'];

      const options: XcodeBuildOptions = {};
      if (flags['xcodegen-spec'] || flags['xcodegen-project'] || flags['xcodegen-project-root']) {
        options.xcodegen = {
          ...(flags['xcodegen-spec'] && { spec: flags['xcodegen-spec'] }),
          ...(flags['xcodegen-project'] && { project: flags['xcodegen-project'] }),
          ...(flags['xcodegen-project-root'] && { projectRoot: flags['xcodegen-project-root'] }),
        };
      }

      this.info(`Syncing ${syncPath} to instance ${id}...`);
      const syncStart = Date.now();
      const syncResult = await xcodeClient.sync(syncPath, {
        watch: false,
        install: false,
        basisCacheDir: flags['basis-cache-dir'],
        ignore: compileIgnorePatterns(flags.ignore),
        include: compileIgnorePatterns(flags.include),
        additionalFiles: parseAdditionalFileFlags(flags['additional-file']),
      } as Parameters<typeof xcodeClient.sync>[1]);
      const syncedSize =
        syncResult.bytesSent !== undefined ? ` (${formatBytes(syncResult.bytesSent)} sent)` : '';
      this.info(`Sync completed in ${formatDurationMs(Date.now() - syncStart)}${syncedSize}.`);
      this.info(
        flags['build-only'] ? 'Building for testing...' : (
          'Building for testing, then running on the simulator...'
        ),
      );

      let summary: XctestSummaryEvent | undefined;
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
        } else {
          summary = event;
        }
      };

      const proc = xcodeClient.xcodebuild(settings as Parameters<typeof xcodeClient.xcodebuild>[0], options);

      if (!json) {
        proc.stdout.on('data', (line: string) => process.stdout.write(line + '\n'));
        proc.stderr.on('data', (line: string) => process.stderr.write(line + '\n'));
      }

      const result = await proc;

      if (json) {
        process.stdout.write(JSON.stringify({ exitCode: result.exitCode }) + '\n');
      } else if (sawCases || result.xctest) {
        this.output('');
        this.output(formatSummaryLine(result.xctest?.summary ?? summary));
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
