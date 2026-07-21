import os from 'os';
import path from 'path';
import prompts from 'prompts';
import { BaseCommand } from '../base-command';
import { ProgressReporter } from '../lib/progress';
import { readConfig, registerCreatedInstance } from '../lib/config';
import { detectProject, type ProjectDetection } from '../lib/project-detection';
import {
  applyProjectEnvApiKey,
  ensureLoggedIn,
  ensureProjectEnvApiKey,
  ensureSampleRepo,
  installProjectSkills,
  type SkillInstallResult,
} from '../lib/onboarding';

const VERSION = require('../../package.json').version;

const XCODE_SKILL = 'limrun-xcode';
const IOS_SIMULATOR_SKILL = 'limrun-ios-simulator';
const EXPO_SKILL = 'limrun-expo-development';
type DetectedProject = Extract<ProjectDetection, { kind: 'native-ios' | 'expo' }>;
type BuildAndLaunchOptions = {
  projectRoot: string;
  displayName: string;
  labels: Record<string, string>;
  progressLabel: string;
  failureLabel: string;
  recoveryPath: string;
  recoveryFromDir: string;
};

export default class Run extends BaseCommand {
  static baseFlags = {
    'api-key': BaseCommand.baseFlags['api-key'],
    quiet: BaseCommand.baseFlags.quiet,
  } as unknown as typeof BaseCommand.baseFlags;
  static hiddenAliases = ['go'];
  static summary = 'Get started with Limrun';
  static description = 'Prepare your app for Limrun, or launch a working sample in a cloud simulator.';
  static examples = ['<%= config.bin %> run'];
  private reporter = new ProgressReporter(() => this.shouldSuppressInfo());

  async run(): Promise<void> {
    const { flags } = await this.parse(Run);
    this.setParsedFlags(flags);

    const detection = detectProject(process.cwd());
    const useDetectedProject =
      detection.kind !== 'sample' ? await this.shouldUseDetectedProject(detection) : false;
    const envRoot = detection.kind !== 'sample' && useDetectedProject ? detection.projectDir : process.cwd();
    const projectEnvApiKey = flags['api-key'] ? undefined : applyProjectEnvApiKey(envRoot).apiKey;

    await ensureLoggedIn({
      version: VERSION,
      apiKey: flags['api-key'],
      log: (message) => this.info(message),
    });

    const apiKey = flags['api-key'] || readConfig().apiKey;
    const allowAuthRetry = !flags['api-key'] && !projectEnvApiKey && !process.env['LIM_API_KEY'];
    if (detection.kind === 'native-ios' && useDetectedProject) {
      await this.setupExistingProject(detection, [XCODE_SKILL, IOS_SIMULATOR_SKILL], apiKey, allowAuthRetry);
      return;
    }
    if (detection.kind === 'expo' && useDetectedProject) {
      await this.setupExistingProject(
        detection,
        [XCODE_SKILL, IOS_SIMULATOR_SKILL, EXPO_SKILL],
        apiKey,
        allowAuthRetry,
      );
      return;
    }

    await this.runSampleFlow(apiKey, allowAuthRetry);
  }

  private async setupExistingProject(
    detection: Extract<ProjectDetection, { kind: 'native-ios' | 'expo' }>,
    skillNames: string[],
    apiKey: string,
    allowAuthRetry: boolean,
  ): Promise<void> {
    const projectRoot = detection.projectDir;
    const projectPath = humanPath(projectRoot);
    await this.reporter.withProgress('Checking Limrun access', () => this.validateAuth(allowAuthRetry));
    this.reporter.success(`Detected an iOS/Expo project at ${projectPath}`);
    const results = await this.reporter.withProgress('Installing Limrun agent skills', () =>
      installProjectSkills({ projectRoot, skillNames }),
    );
    this.printSkillSummary(results);
    this.printEnvWarnings(ensureProjectEnvApiKey(projectRoot, apiKey).warnings);
    this.reporter.success('Configured .env for Limrun');

    const streamUrl = await this.buildAndLaunchProject({
      projectRoot,
      displayName: 'lim-run-project',
      labels: {
        name: 'lim-run-project',
        projectKind: detection.kind,
      },
      progressLabel: buildProgressLabel(detection.kind),
      failureLabel: 'Build failed',
      recoveryPath: projectRoot,
      recoveryFromDir: process.cwd(),
    });

    this.output('');
    this.output('✨ Click here to see your app:');
    this.output(streamUrl);
    this.outputNextSteps(projectRoot, 'Make a change and rebuild with Limrun skills.');
  }

  private async shouldUseDetectedProject(detection: DetectedProject): Promise<boolean> {
    if (this.shouldSuppressInfo() || !process.stdin.isTTY || !process.stderr.isTTY) {
      return true;
    }
    const projectPath = interactivePathLabel(humanPath(detection.projectDir));
    const response = await prompts(
      {
        type: 'select',
        name: 'choice',
        message: `Found an iOS/Expo project at ${projectPath}. What do you want to use?`,
        choices: [
          { title: `Use ${projectPath}`, value: 'project' },
          { title: 'Clone and run the sample app', value: 'sample' },
        ],
        initial: 0,
      },
      {
        onCancel: () => {
          this.error('Cancelled.');
        },
      },
    );
    return response.choice !== 'sample';
  }

  private printSkillSummary(results: SkillInstallResult[]): void {
    const installed = results.filter((result) => result.status === 'installed').length;
    const unchanged = results.filter((result) => result.status === 'unchanged').length;
    const updated = results.filter((result) => result.status === 'updated');
    if (installed > 0 || updated.length > 0) {
      this.reporter.success('Limrun skills installed for Claude Code and Cursor/OpenCode-compatible agents');
    } else if (unchanged > 0) {
      this.reporter.success(
        'Limrun skills are already installed for Claude Code and Cursor/OpenCode-compatible agents',
      );
    }
    if (updated.length > 0) {
      this.info('Updated skill directories that had local changes:');
      for (const result of updated) {
        this.info(`  ${humanPath(result.path)}`);
      }
      this.info('Review the diff in version control and ask your agent to reconcile if needed.');
    }
  }

  private printEnvWarnings(warnings: string[]): void {
    for (const warning of warnings) {
      this.info(`Warning: ${warning}`);
    }
  }

  private async validateAuth(allowRetry: boolean): Promise<void> {
    const check = async () => {
      await this.client.iosInstances.list({ state: 'ready' } as any);
    };
    if (allowRetry) {
      await this.withAuth(check);
      return;
    }
    await check();
  }

  private async runSampleFlow(apiKey: string, allowAuthRetry: boolean): Promise<void> {
    const cwd = process.cwd();
    await this.reporter.withProgress('Checking Limrun access', () => this.validateAuth(allowAuthRetry));
    const sample = await this.reporter.withProgress('Setting up sample app', () => ensureSampleRepo({ cwd }));
    const samplePathFromStart = humanPath(sample.path, cwd);
    this.reporter.success(`${sample.reused ? 'Using existing' : 'Cloned'} ${samplePathFromStart}`);
    process.chdir(sample.path);
    this.printEnvWarnings(ensureProjectEnvApiKey(sample.path, apiKey).warnings);
    this.reporter.success('Configured .env for Limrun');

    const streamUrl = await this.buildAndLaunchProject({
      projectRoot: process.cwd(),
      displayName: 'lim-run-sample',
      labels: {
        name: 'lim-go-sample',
        repo: 'sample-native-app',
      },
      progressLabel: buildProgressLabel('native-ios'),
      failureLabel: 'Sample build failed',
      recoveryPath: sample.path,
      recoveryFromDir: cwd,
    });

    this.output('');
    this.output('✨ Click here to see your app:');
    this.output(streamUrl);
    this.outputNextSteps(sample.path, samplePrompt());
  }

  private async buildAndLaunchProject({
    projectRoot,
    displayName,
    labels,
    progressLabel,
    failureLabel,
    recoveryPath,
    recoveryFromDir,
  }: BuildAndLaunchOptions): Promise<string> {
    let recoveryPrinted = false;
    try {
      return await this.withAuth(async () => {
        const instance = await this.reporter.withProgress('Preparing a Limrun iOS simulator with Xcode', () =>
          this.client.iosInstances.create({
            wait: true,
            reuseIfExists: true,
            metadata: {
              displayName,
              labels,
            },
            spec: {
              sandbox: {
                xcode: {
                  enabled: true,
                },
              },
            },
          }),
        );
        registerCreatedInstance(instance, ['xcode']);

        const xcodeUrl = instance.status.sandbox?.xcode?.url;
        if (!xcodeUrl) {
          this.error('The iOS instance is ready, but its Xcode sandbox URL is missing.');
        }

        const xcode = await this.client.xcodeInstances.createClient({
          apiUrl: xcodeUrl,
          token: instance.status.token,
        });

        await xcode.sync(projectRoot, { watch: false });

        const build = xcode.xcodebuild();
        this.reporter.start(progressLabel);
        build.stdout.on('data', (line: string) => this.reporter.appendLog(line));
        build.stderr.on('data', (line: string) => this.reporter.appendLog(line));
        const buildStart = Date.now();
        let result: Awaited<typeof build>;
        try {
          result = await build;
        } catch (err) {
          this.reporter.stop('failure');
          throw err;
        }
        if (result.exitCode !== 0) {
          this.reporter.stop('failure');
          this.outputProjectRecovery(recoveryPath, recoveryFromDir);
          recoveryPrinted = true;
          this.error(`${failureLabel} with exit code ${result.exitCode}`, { exit: result.exitCode });
        }
        this.reporter.stop('success', `Built and launched in ${formatDurationMs(Date.now() - buildStart)}`);

        const streamUrl = this.signedStreamUrl(instance.status);
        if (!streamUrl) {
          this.error('The iOS instance is ready, but its signed stream URL is missing.');
        }
        return streamUrl;
      });
    } catch (err) {
      if (!recoveryPrinted) {
        this.outputProjectRecovery(recoveryPath, recoveryFromDir);
      }
      throw err;
    }
  }

  private outputProjectRecovery(projectPath: string, fromDir = process.cwd()): void {
    this.output('');
    this.output(`Project is available at ${humanPath(projectPath, fromDir)}.`);
    this.output('Open it with your coding agent to continue.');
  }

  private outputNextSteps(projectPath: string, prompt: string): void {
    this.output('');
    this.output('Next steps:');
    this.output('');
    this.output(`- Open ${bold(userFacingAbsolutePath(projectPath))} in your coding agent`);
    this.output('');
    this.output(`- Prompt it: "${prompt}"`);
  }
}

function humanPath(absolutePath: string, fromDir = process.cwd()): string {
  const relative = path.relative(fromDir, absolutePath);
  if (!relative) return '.';
  if (relative.startsWith('..') || path.isAbsolute(relative)) return absolutePath;
  return relative;
}

function userFacingAbsolutePath(filePath: string): string {
  const absolutePath = path.resolve(filePath);
  const homeDir = os.homedir();
  if (!homeDir) {
    return absolutePath;
  }
  const relativeToHome = path.relative(homeDir, absolutePath);
  if (relativeToHome === '') {
    return '~';
  }
  if (!relativeToHome.startsWith('..') && !path.isAbsolute(relativeToHome)) {
    return path.join('~', relativeToHome);
  }
  return absolutePath;
}

function interactivePathLabel(value: string): string {
  return value === '.' ? 'current directory' : value;
}

function buildProgressLabel(kind: DetectedProject['kind']): string {
  if (kind === 'expo') {
    return 'Building and launching app (est. 5-10m)';
  }
  return 'Building and launching app (est. 30s-5m)';
}

function samplePrompt(): string {
  return `Change \`Hello, world!\` to \`Hello, ${environmentUserName()}!\` and use Limrun skills.`;
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function bold(value: string): string {
  return `\x1b[1m${value}\x1b[22m`;
}

function environmentUserName(): string {
  return process.env['USER'] || process.env['USERNAME'] || safeOsUserName() || 'Limrun';
}

function safeOsUserName(): string | undefined {
  try {
    return os.userInfo().username;
  } catch {
    return undefined;
  }
}
