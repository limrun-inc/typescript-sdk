import fs from 'fs';
import path from 'path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { findBazelWorkspaceRoot, inferBuildTarget, defaultBepPath } from '../../../lib/rbe-workspace';
import { readRbePidFile } from '../../../lib/rbe-session';

export default class XcodeRbeInstall extends BaseCommand {
  static summary = 'Install a Bazel RBE build on the attached simulator (no client download)';
  static description =
    'After `bazelisk build --config=limrun <target>`, install the built app on the Xcode ' +
    "instance's attached simulator. The .ipa stays in the instance cache (it is never downloaded " +
    'to this machine); its CAS digest is read from the Bazel build event log (.limrun/bep.json) ' +
    'and the instance fetches, unpacks, and diff-syncs the app to the simulator. Run it AFTER the ' +
    'build, with a simulator attached (e.g. via `lim xcode rbe --ios`). The target is optional ' +
    'when the workspace has a single app target.';
  static examples = ['<%= config.bin %> xcode rbe install', '<%= config.bin %> xcode rbe install //App:App'];

  static args = {
    target: Args.string({
      description:
        'The Bazel target that was built (e.g. //App:App). Optional: inferred when the workspace has exactly one app target.',
      required: false,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description:
        'Xcode instance ID to target. Defaults to the most recent standalone Xcode target (the one `lim xcode rbe` used).',
    }),
    'bep-file': Flags.string({
      description:
        "Path to Bazel's build event log to read the .ipa digest from. Defaults to the path `lim xcode rbe` recorded, or .limrun/bep.json.",
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(XcodeRbeInstall);
    // Never auto-create: install must hit the existing instance whose cache holds
    // the just-built artifact. Without this, a vanished pinned instance would trip
    // withAuth's NotFound recovery and spawn a fresh, empty Xcode instance (whose
    // CAS lacks the .ipa), failing confusingly after leaking an instance.
    this.setParsedFlags({ ...flags, create: false });

    const workspaceRoot = findBazelWorkspaceRoot(process.cwd());
    if (!workspaceRoot) {
      this.error(
        'Not inside a Bazel workspace. Run `lim xcode rbe install` from within the workspace you built.',
      );
    }

    // The target may be omitted when the workspace has exactly one app target;
    // otherwise it must be given explicitly (we never guess between several).
    const buildTarget = args.target ?? inferBuildTarget(workspaceRoot);
    if (!buildTarget) {
      this.error(
        'Could not infer a single app target. Pass the target explicitly, e.g. ' +
          '`lim xcode rbe install //App:App`.',
      );
    }

    // The generated bazelrc writes the build event log on every --config=limrun
    // build; read the just-built target's .ipa digest from it. Prefer an explicit
    // --bep-file, then the path `lim xcode rbe` recorded in the pidfile (in case a
    // custom --bep-file was used), then the default under .limrun/.
    const pidInfo = readRbePidFile(workspaceRoot);
    const bepPath =
      (flags['bep-file'] ? path.resolve(flags['bep-file']) : undefined) ??
      pidInfo?.bepFile ??
      defaultBepPath(workspaceRoot);
    let bepJson: string;
    try {
      bepJson = fs.readFileSync(bepPath, 'utf8');
    } catch {
      this.error(
        `No build event log at ${bepPath}. Build first with --config=limrun ` +
          `(e.g. \`bazelisk --digest_function=sha256 build --config=limrun ${buildTarget}\`), then re-run.`,
      );
    }

    // Target the instance the background tunnel is serving for this workspace
    // (recorded in .limrun/rbe.pid by `lim xcode rbe`), since that's the one
    // whose CAS holds the build. An explicit --id wins; otherwise fall back to
    // the pidfile, then to the most recent Xcode target.
    const instanceId = flags.id ?? pidInfo?.instanceId;

    await this.withAuth(async () => {
      // Target an existing instance (do not create): install needs the instance
      // whose cache holds the just-built artifact.
      const target = await this.resolveXcodeTarget(instanceId);
      const client = await this.resolveXcodeClient(target);

      this.info(`Installing ${buildTarget} on the attached simulator...`);
      // The SDK parses the .ipa's CAS digest out of the BEP and installs it; a
      // missing target/.ipa or a non-SHA256 (BLAKE3) digest surfaces clearly here.
      let result;
      try {
        result = await client.installRbeBuildFromBep({ bep: bepJson, target: buildTarget });
      } catch (err) {
        this.error(err instanceof Error ? err.message : String(err));
      }

      if (flags.json) {
        this.outputJson({ ...result, target: buildTarget });
        return;
      }
      const appName = result.appName ?? result.ipaName;
      if (!result.installed) {
        // No simulator attached: nothing was installed. Attach one and re-run
        // (e.g. `lim xcode rbe --ios`, then `lim xcode rbe install`).
        this.output(
          `No simulator attached, so ${appName} was not installed. ` +
            'Attach one (e.g. `lim xcode rbe --ios`) and re-run.',
        );
        return;
      }
      const timing =
        result.syncDurationMs !== undefined ?
          ` (synced in ${result.syncDurationMs}ms, installed in ${result.installDurationMs ?? 0}ms)`
        : '';
      this.output(`Installed ${appName}${timing}`);
      if (result.bundleId) {
        this.output(`Bundle ID: ${result.bundleId}`);
      }
      // Point the stream at the attached simulator, not the Xcode host. For an
      // iOS-backed target the target id is the simulator; otherwise resolve it
      // from the attached simulator (install only reaches here with one attached).
      // Best-effort: the install already succeeded, so never fail over the URL.
      const simId =
        target.type === 'ios' ?
          target.id
        : await client
            .getSimulator()
            .then((s) => s.simulator?.iosInstanceId)
            .catch(() => undefined);
      if (simId) {
        this.output(`iOS Simulator URL: ${this.consoleStreamUrl(simId)}`);
      }
    });
  }
}
