import os from 'os';
import path from 'path';
import { ux } from '@oclif/core';
import prompts from 'prompts';
import { BaseCommand } from '../base-command';
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

const IOS_SKILL = 'limrun-xcode-and-ios-simulator';
const EXPO_SKILL = 'limrun-expo-development';
const SPINNER_FRAMES =
  process.platform === 'win32' ? ['-', '\\', '|', '/'] : ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SUCCESS_ICON = process.platform === 'win32' ? '√' : '✔';
const FAILURE_ICON = process.platform === 'win32' ? '×' : '✖';
const BUILD_LOG_TAIL_LINES = 10;
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
  private progress?: ProgressState;

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
      await this.setupExistingProject(detection, [IOS_SKILL], apiKey, allowAuthRetry);
      return;
    }
    if (detection.kind === 'expo' && useDetectedProject) {
      await this.setupExistingProject(detection, [IOS_SKILL, EXPO_SKILL], apiKey, allowAuthRetry);
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
    await this.withProgress('Checking Limrun access', () => this.validateAuth(allowAuthRetry));
    this.success(`Detected an iOS/Expo project at ${projectPath}`);
    const results = await this.withProgress('Installing Limrun agent skills', () =>
      installProjectSkills({ projectRoot, skillNames }),
    );
    this.printSkillSummary(results);
    this.printEnvWarnings(ensureProjectEnvApiKey(projectRoot, apiKey).warnings);
    this.success('Configured .env for Limrun');

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
    this.outputNextSteps(projectPath, 'Make a change and rebuild with Limrun skills.');
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
    const skipped = results.filter((result) => result.status === 'skipped');
    if (installed > 0) {
      this.success('Limrun skills installed for Claude Code and Cursor/OpenCode-compatible agents');
    } else if (unchanged > 0 && skipped.length === 0) {
      this.success(
        'Limrun skills are already installed for Claude Code and Cursor/OpenCode-compatible agents',
      );
    }
    if (skipped.length > 0) {
      this.info('Skipped skill directories with local changes:');
      for (const result of skipped) {
        this.info(`  ${humanPath(result.path)}`);
      }
      this.info('Run `lim skills install` interactively, or rerun it with `--force`, to update them.');
    }
  }

  private printEnvWarnings(warnings: string[]): void {
    for (const warning of warnings) {
      this.info(`Warning: ${warning}`);
    }
  }

  private success(message: string): void {
    if (this.shouldSuppressInfo()) {
      return;
    }
    process.stderr.write(`${ux.colorize('green', SUCCESS_ICON)} ${message}\n`);
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
    await this.withProgress('Checking Limrun access', () => this.validateAuth(allowAuthRetry));
    const sample = await this.withProgress('Setting up sample app', () => ensureSampleRepo({ cwd }));
    const samplePathFromStart = humanPath(sample.path, cwd);
    this.success(`${sample.reused ? 'Using existing' : 'Cloned'} ${samplePathFromStart}`);
    process.chdir(sample.path);
    this.printEnvWarnings(ensureProjectEnvApiKey(sample.path, apiKey).warnings);
    this.success('Configured .env for Limrun');

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
    this.outputNextSteps(humanPath(sample.path, cwd), samplePrompt());
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
        const instance = await this.withProgress('Preparing a Limrun iOS simulator with Xcode', () =>
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
        this.startProgress(progressLabel);
        build.stdout.on('data', (line: string) => this.appendProgressLog(line));
        build.stderr.on('data', (line: string) => this.appendProgressLog(line));
        const buildStart = Date.now();
        let result: Awaited<typeof build>;
        try {
          result = await build;
        } catch (err) {
          this.stopProgress('failure');
          throw err;
        }
        if (result.exitCode !== 0) {
          this.stopProgress('failure');
          this.outputProjectRecovery(recoveryPath, recoveryFromDir);
          recoveryPrinted = true;
          this.error(`${failureLabel} with exit code ${result.exitCode}`, { exit: result.exitCode });
        }
        this.stopProgress('success', `Built and launched in ${formatDurationMs(Date.now() - buildStart)}`);

        return this.consoleStreamUrl(instance.metadata.id);
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
    this.output(`- Open ${bold(interactivePathLabel(projectPath))} in your coding agent`);
    this.output('');
    this.output(`- Prompt it: "${prompt}"`);
  }

  private async withProgress<T>(message: string, run: () => Promise<T>): Promise<T> {
    this.startProgress(message);
    try {
      const result = await run();
      this.stopProgress('success');
      return result;
    } catch (err) {
      this.stopProgress('failure');
      throw err;
    }
  }

  private startProgress(message: string): void {
    if (this.shouldSuppressInfo()) {
      return;
    }
    this.progress = { frame: 0, logLines: [], message, renderedRows: 0 };
    if (process.stderr.isTTY) {
      this.progress.timer = setInterval(
        () => this.renderProgress(),
        process.platform === 'win32' ? 500 : 100,
      );
      this.progress.timer.unref();
      this.renderProgress();
    }
  }

  private stopProgress(result: 'success' | 'failure' = 'success', message?: string): void {
    if (this.shouldSuppressInfo() || !this.progress) {
      return;
    }
    const progress = this.progress;
    if (progress.timer) {
      clearInterval(progress.timer);
    }
    this.progress = undefined;
    this.clearProgressBlock(progress);
    const icon = result === 'success' ? ux.colorize('green', SUCCESS_ICON) : ux.colorize('red', FAILURE_ICON);
    process.stderr.write(`${icon} ${message ?? progress.message}\n`);
  }

  private appendProgressLog(chunk: string): void {
    if (this.shouldSuppressInfo() || !this.progress) {
      return;
    }
    const lines = String(chunk)
      .replace(/\r/g, '\n')
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    if (lines.length === 0) {
      return;
    }
    this.progress.logLines.push(...lines);
    this.progress.logLines = this.progress.logLines.slice(-BUILD_LOG_TAIL_LINES);
    this.renderProgress();
  }

  private renderProgress(): void {
    if (!this.progress || !process.stderr.isTTY) {
      return;
    }
    const frame = SPINNER_FRAMES[this.progress.frame % SPINNER_FRAMES.length]!;
    this.progress.frame += 1;
    const lines = [
      progressLine(`${ux.colorize('magenta', frame)} ${this.progress.message}`),
      ...this.progress.logLines.map((line) => ux.colorize('dim', `  ${truncateTerminalLine(line, 2)}`)),
    ];
    this.clearProgressBlock(this.progress);
    this.progress.renderedRows = lines.length;
    process.stderr.write(lines.join('\n'));
  }

  private clearProgressBlock(progress: ProgressState): void {
    if (!process.stderr.isTTY) {
      return;
    }
    process.stderr.clearLine(0);
    process.stderr.cursorTo(0);
    for (let i = 1; i < progress.renderedRows; i += 1) {
      process.stderr.moveCursor(0, -1);
      process.stderr.clearLine(0);
      process.stderr.cursorTo(0);
    }
  }
}

type ProgressState = {
  frame: number;
  logLines: string[];
  message: string;
  renderedRows: number;
  timer?: NodeJS.Timeout;
};

function humanPath(absolutePath: string, fromDir = process.cwd()): string {
  const relative = path.relative(fromDir, absolutePath);
  if (!relative) return '.';
  if (relative.startsWith('..') || path.isAbsolute(relative)) return absolutePath;
  return relative;
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
  return `Change \`Hello, world!\` to \`Hello, ${environmentUserName()}!\``;
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

function progressLine(line: string): string {
  const width = process.stderr.columns;
  if (!width || line.length < width - 1) {
    return line;
  }
  return `${line.slice(0, Math.max(0, width - 4))}...`;
}

function truncateTerminalLine(line: string, indent = 0): string {
  const width = process.stderr.columns;
  const max = width ? width - indent - 1 : undefined;
  if (!max || line.length < max) {
    return line;
  }
  return `${line.slice(0, Math.max(0, max - 3))}...`;
}
