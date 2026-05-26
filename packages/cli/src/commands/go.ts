import path from 'path';
import { BaseCommand } from '../base-command';
import { registerCreatedInstance } from '../lib/config';
import { detectProject, type ProjectDetection } from '../lib/project-detection';
import {
  ensureLoggedIn,
  ensureSampleRepo,
  installProjectSkills,
  SAMPLE_NATIVE_APP_DIR,
  verifySampleAgentPaths,
  type SkillInstallResult,
} from '../lib/onboarding';

const VERSION = require('../../package.json').version;

const IOS_SKILL = 'limrun-xcode-and-ios-simulator';
const EXPO_SKILL = 'limrun-expo-development';

export default class Go extends BaseCommand {
  static baseFlags = {
    'api-key': BaseCommand.baseFlags['api-key'],
    quiet: BaseCommand.baseFlags.quiet,
  } as unknown as typeof BaseCommand.baseFlags;
  static summary = 'Get started with Limrun';
  static description = 'Prepare your app for Limrun, or launch a working sample in a cloud simulator.';
  static examples = ['<%= config.bin %> go'];

  async run(): Promise<void> {
    const { flags } = await this.parse(Go);
    this.setParsedFlags(flags);

    await ensureLoggedIn({
      version: VERSION,
      apiKey: flags['api-key'],
      log: (message) => this.info(message),
    });

    const detection = detectProject(process.cwd());
    if (detection.kind === 'native-ios') {
      await this.setupExistingProject(detection, [IOS_SKILL]);
      return;
    }
    if (detection.kind === 'expo') {
      await this.setupExistingProject(detection, [IOS_SKILL, EXPO_SKILL]);
      return;
    }

    await this.runSampleFlow();
  }

  private async setupExistingProject(
    detection: Extract<ProjectDetection, { kind: 'native-ios' | 'expo' }>,
    skillNames: string[],
  ): Promise<void> {
    const projectRoot = detection.projectDir;
    const projectPath = humanPath(projectRoot);
    await this.validateAuth();
    this.info('Detected an iOS/Expo project.');
    this.info('Installing Limrun agent skills...');
    const results = await installProjectSkills({ projectRoot, skillNames });
    this.printSkillSummary(results);

    this.output('');
    if (projectPath !== '.') {
      this.output(`Project: ${projectPath}`);
      this.output(`Run your coding agent from: cd ${shellQuote(projectPath)}`);
      this.output('');
    }
    this.output('Next steps: open your coding agent in this project and ask:');
    if (detection.kind === 'expo') {
      this.output('"Build and run this Expo app with Limrun. Share the simulator URL when it is ready."');
    } else {
      this.output('"Build and run this iOS app with Limrun. Share the simulator URL when it is ready."');
    }
    this.output('');
    this.output(`CLI anchor: ${this.buildCliAnchor(detection)}`);
  }

  private printSkillSummary(results: SkillInstallResult[]): void {
    const installed = results.filter((result) => result.status === 'installed').length;
    const unchanged = results.filter((result) => result.status === 'unchanged').length;
    const skipped = results.filter((result) => result.status === 'skipped');
    if (installed > 0) {
      this.info('Limrun skills installed for Claude Code and Cursor/OpenCode-compatible agents.');
    } else if (unchanged > 0 && skipped.length === 0) {
      this.info('Limrun skills are already installed for Claude Code and Cursor/OpenCode-compatible agents.');
    }
    if (skipped.length > 0) {
      this.info('Skipped skill directories with local changes:');
      for (const result of skipped) {
        this.info(`  ${humanPath(result.path)}`);
      }
      this.info('Run `lim skills install` interactively, or rerun it with `--force`, to update them.');
    }
  }

  private async validateAuth(): Promise<void> {
    await this.withAuth(async () => {
      await this.client.iosInstances.list({ state: 'ready' } as any);
    });
  }

  private buildCliAnchor(detection: Extract<ProjectDetection, { kind: 'native-ios' | 'expo' }>): string {
    const projectPath = humanPath(detection.projectDir);
    if (projectPath !== '.') {
      return `cd ${shellQuote(projectPath)} && lim xcode build .`;
    }
    return 'lim xcode build .';
  }

  private async runSampleFlow(): Promise<void> {
    const cwd = process.cwd();
    this.info('No iOS or Expo project detected. Setting up the sample app.');
    const sample = await ensureSampleRepo({ cwd });
    this.info(`${sample.reused ? 'Using existing' : 'Cloned'} ${humanPath(sample.path)}.`);

    const unavailableAgentPaths = verifySampleAgentPaths(sample.path);
    if (unavailableAgentPaths.length > 0) {
      this.info('Some sample agent skill paths are unavailable:');
      for (const unavailablePath of unavailableAgentPaths) {
        this.info(`  ${path.join(SAMPLE_NATIVE_APP_DIR, unavailablePath)}`);
      }
    }

    let recoveryPrinted = false;
    try {
      await this.withAuth(async () => {
        this.info('Preparing a Limrun iOS simulator with Xcode...');
        const instance = await this.client.iosInstances.create({
          wait: true,
          reuseIfExists: true,
          metadata: {
            displayName: 'lim-go-sample',
            labels: {
              name: 'lim-go-sample',
              repo: 'sample-native-app',
            },
          },
          spec: {
            sandbox: {
              xcode: {
                enabled: true,
              },
            },
          },
        });
        registerCreatedInstance(instance, ['xcode']);

        const xcodeUrl = instance.status.sandbox?.xcode?.url;
        if (!xcodeUrl) {
          this.error('The iOS instance is ready, but its Xcode sandbox URL is missing.');
        }

        const xcode = await this.client.xcodeInstances.createClient({
          apiUrl: xcodeUrl,
          token: instance.status.token,
        });

        this.info('Syncing sample app...');
        await xcode.sync(sample.path, { watch: false });

        this.info('Building and launching sample app...');
        const xcodeSandboxId = xcodeSandboxIdFromUrl(xcodeUrl);
        if (xcodeSandboxId) {
          this.outputBuildInProgress(xcodeSandboxId);
        }
        const build = xcode.xcodebuild();
        const result = await build;
        if (result.exitCode !== 0) {
          this.outputSampleRecovery(sample.path);
          recoveryPrinted = true;
          this.error(`Sample build failed with exit code ${result.exitCode}`, { exit: result.exitCode });
        }

        this.output('Build completed successfully!');
        this.output('');
        this.output('App deployed and running in a Limrun cloud simulator:');
        this.output(this.consoleStreamUrl(instance.metadata.id));
        this.outputSampleNextStep(sample.path);
      });
    } catch (err) {
      if (!recoveryPrinted) {
        this.outputSampleRecovery(sample.path);
      }
      throw err;
    }
  }

  private outputBuildInProgress(sandboxId: string): void {
    this.output('Build is in progress. You can follow the logs from:');
    this.output(this.consoleBuildUrl(sandboxId));
  }

  private outputSampleRecovery(samplePath: string): void {
    this.output('');
    this.output(`Sample app is available at ${humanPath(samplePath)}.`);
    this.output('Open it with your coding agent to continue.');
  }

  private outputSampleNextStep(samplePath: string): void {
    this.output('');
    this.output('Next steps:');
    this.output(`  cd ${shellQuote(humanPath(samplePath))}`);
    this.output('  Open your favorite coding agent and ask:');
    this.output(
      '  "Change `Hello, world!` to `Hello, Limrun!`, rebuild with Limrun, and show me the updated simulator."',
    );
    this.output('  Start building your app.');
  }
}

function humanPath(absolutePath: string): string {
  const relative = path.relative(process.cwd(), absolutePath);
  if (!relative) return '.';
  if (relative.startsWith('..') || path.isAbsolute(relative)) return absolutePath;
  return relative;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function xcodeSandboxIdFromUrl(url: string): string | undefined {
  return url.match(/\/(sandbox_[^/]+)(?:\/|$)/)?.[1];
}
