import readline from 'readline/promises';
import { Flags } from '@oclif/core';
import { detectBazelMajorVersion, findBazelWorkspaceRoot } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import {
  appendModuleLines,
  bazelTooOld,
  CREDENTIAL_HELPER,
  credentialHelperOnPath,
  detectWorkspaceKinds,
  getBazelSetup,
  missingAndroidModuleLines,
  writePlaneWorkspaceFiles,
} from '../../lib/bazel-setup';

export default class BazelSetup extends BaseCommand {
  static summary = "Set up a Bazel workspace to build on Limrun's build plane";
  static description =
    "Configures the Bazel workspace in the current directory for Limrun remote execution and caching, under --config=limrun. Apple actions run on Limrun's Macs, Android actions on its Linux workers, and every build of your organization shares one cache. Writes a gitignored .limrun/ directory and adds a try-import to .bazelrc. For an Android workspace it also adds what Linux workers need to the root MODULE.bazel, after showing the lines and asking. Bazel gets its credentials from lim-bazel-credentials, which uses your `lim login` or LIM_API_KEY; nothing secret is written to disk.";
  static examples = [
    '<%= config.bin %> bazel setup',
    '<%= config.bin %> bazel setup --region eu-north1',
    '<%= config.bin %> bazel setup --yes',
  ];

  static flags = {
    ...BaseCommand.readOnlyFlags,
    region: Flags.string({
      description: 'Use the build plane in this region instead of the closest one.',
    }),
    yes: Flags.boolean({
      char: 'y',
      description: 'Add the lines an Android workspace needs to MODULE.bazel without asking.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(BazelSetup);
    this.setParsedFlags(flags);

    const workspaceRoot = findBazelWorkspaceRoot(process.cwd());
    if (!workspaceRoot) {
      this.error('No Bazel workspace found: run lim bazel setup inside one, next to its MODULE.bazel.');
    }
    const bazelMajor = detectBazelMajorVersion(workspaceRoot);
    const tooOld = bazelTooOld(bazelMajor);
    if (tooOld) this.error(tooOld);
    const kinds = detectWorkspaceKinds(workspaceRoot);
    if (!kinds.apple && !kinds.android) {
      this.error(
        'This workspace depends on neither rules_apple nor rules_android, so nothing would run on the build plane.',
      );
    }

    const setup = await this.withAuth(() => getBazelSetup(this.client, flags.region), {
      createReplacement: false,
    });

    // Ask before writing anything, and write MODULE.bazel last, so a refusal or
    // a failure never leaves the workspace half set up.
    const lines = kinds.android ? missingAndroidModuleLines(workspaceRoot) : '';
    if (lines && !(await this.confirmModuleLines(lines, flags.yes))) {
      this.error('Setup stopped: Android builds on Linux workers need these lines in MODULE.bazel.');
    }
    const files = writePlaneWorkspaceFiles(workspaceRoot, setup, kinds, bazelMajor);
    if (lines) appendModuleLines(workspaceRoot, lines);
    if (flags.json) {
      this.outputJson({ ...setup, workspaceRoot, apple: kinds.apple, android: kinds.android });
      return;
    }
    this.info(`Configured ${workspaceRoot} for the build plane in ${setup.region}.`);
    this.info(`  ${files.bazelrc}`);
    this.info(`  ${files.buildFile}`);
    if (files.bazelrcUpdated) this.info('  .bazelrc now imports .limrun/bazelrc');
    this.info('');
    if (!credentialHelperOnPath()) {
      this.warn(
        `${CREDENTIAL_HELPER} is not on PATH, so Bazel cannot authenticate. Install the CLI with npm install -g lim.`,
      );
    }
    this.info('Build with: bazel build --config=limrun //your:target');
  }

  /**
   * Shows the lines and asks, unless --yes. It never asks about lines the user
   * cannot see: without a terminal, or under --json/--quiet, it stops instead.
   */
  private async confirmModuleLines(lines: string, yes: boolean): Promise<boolean> {
    this.info('Android builds on Linux workers need these lines in MODULE.bazel:');
    this.info(lines);
    if (yes) return true;
    if (this.shouldSuppressInfo() || !process.stdin.isTTY || !process.stderr.isTTY) {
      this.error(
        'MODULE.bazel lacks lines Android builds on Linux workers need. Rerun with --yes to add them, or without --json/--quiet in a terminal to review them.',
      );
    }
    const prompt = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await prompt.question('Add them to MODULE.bazel? [y/N] ');
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      prompt.close();
    }
  }
}
