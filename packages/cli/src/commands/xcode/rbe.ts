import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { Flags } from '@oclif/core';
import type { Tunnel, XcodeClient } from '@limrun/api';
import { DEFAULT_RBE_TUNNEL_PORT, RbeUnsupportedError } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import { clearLastInstanceId } from '../../lib/config';
import { ProgressReporter } from '../../lib/progress';
import {
  findBazelWorkspaceRoot,
  inferBuildTarget,
  writeRbeWorkspaceFiles,
  resolveBepPath,
  LIMRUN_DIR,
  type RbeWorkspaceFiles,
} from '../../lib/rbe-workspace';
import {
  assertLocalPortFree,
  buildServeChildArgs,
  clearRbePidFile,
  defaultSleep,
  isProcessAlive,
  probePortOpen,
  readRbePidFile,
  retryTransient,
  waitForRbeRunning,
  writeRbePidFile,
} from '../../lib/rbe-session';
import { startBepWatcher, type BepWatcher } from '../../lib/rbe-bep-watcher';

export default class XcodeRbe extends BaseCommand {
  static summary = 'Serve a local Bazel remote-execution endpoint backed by a Limrun Xcode instance';
  static description =
    'Start the embedded Bazel Remote Build Execution stack on an Xcode instance and bridge it to a ' +
    'local TCP port. Point bazel at it with --remote_executor=grpc://127.0.0.1:<port> and actions ' +
    'execute on the remote macOS instance. Run from the root of a Bazel workspace. By default the ' +
    'tunnel runs in the background and the terminal is returned; stop it with `kill <pid>` (printed ' +
    'on start) or by deleting the instance. Pass --no-daemon to keep it in the foreground.';
  static examples = [
    '<%= config.bin %> xcode rbe',
    '<%= config.bin %> xcode rbe --no-daemon',
    '<%= config.bin %> xcode rbe --id <xcode-instance-ID>',
    '<%= config.bin %> xcode rbe --port 9980',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description:
        'Xcode instance ID to target. Defaults to the most recent standalone Xcode target, creating one if needed.',
    }),
    port: Flags.integer({
      description: 'Local TCP port to serve the remote-execution endpoint on.',
      default: DEFAULT_RBE_TUNNEL_PORT,
    }),
    daemon: Flags.boolean({
      description:
        'Run the tunnel as a background process and return the terminal. Use --no-daemon to keep it in the foreground (for CI or debugging).',
      default: true,
      allowNo: true,
    }),
    stop: Flags.boolean({
      description: 'Stop the background tunnel running for this workspace.',
      default: false,
    }),
    ios: Flags.boolean({
      description:
        'Also create an iOS simulator and attach it, so builds auto-install on it and you can watch it live. The simulator is torn down on --stop.',
      default: false,
    }),
    'auto-install': Flags.boolean({
      description:
        'After each build, automatically install it on the attached simulator (and replay the last build when a simulator is attached later). Use --no-auto-install for a tunnel-only session (e.g. CI).',
      default: true,
      allowNo: true,
    }),
    target: Flags.string({
      description:
        'Build target to auto-install after each build (e.g. //App:App). Defaults to the inferred app target; required to auto-install when the workspace has multiple app targets.',
    }),
    'bep-file': Flags.string({
      description:
        "Path for Bazel's build event log (--build_event_json_file), which the auto-install watcher reads " +
        'after each build. Defaults to .limrun/bep.json; set it only if your build already writes the log ' +
        'elsewhere. `lim xcode rbe install` reuses this path automatically.',
    }),
    serve: Flags.boolean({
      hidden: true,
      default: false,
      description: 'Internal: run only the tunnel serve loop (used by the detached background process).',
    }),
    'workspace-root': Flags.string({
      hidden: true,
      description:
        'Internal: workspace root passed to the detached serve process for the auto-install watcher.',
    }),
  };

  private reporter = new ProgressReporter(() => this.shouldSuppressInfo());

  async run(): Promise<void> {
    const { flags } = await this.parse(XcodeRbe);
    this.setParsedFlags(flags);

    // Serve mode: the detached child. The parent already started the stack and
    // generated the workspace config; this process only holds the tunnel and
    // tears the stack down on exit. Requires --id (the parent always passes it).
    if (flags.serve) {
      if (!flags.id) {
        this.error('--serve requires --id (it is set automatically by the background launcher).');
      }
      // This detached process holds the only RBE tunnel. The auto-install watcher
      // runs async work (fs.watch callbacks, BEP parsing, HTTP) whose throws/
      // rejections would otherwise reach Node's default handler and terminate the
      // process, silently dropping Bazel's remote executor mid-build. Swallow them
      // here so a watcher fault can never kill the tunnel; the tunnel's own
      // terminal-disconnect path is handled in awaitTunnel.
      installDaemonCrashGuards((msg) => console.error(`[lim] ${msg}`));
      await this.withAuth(async () => {
        const xcodeTarget = await this.resolveXcodeTarget(flags.id);
        const client = await this.resolveXcodeClient(xcodeTarget);
        const workspaceRoot = flags['workspace-root'];
        const buildTarget = flags.target;
        let watcher: BepWatcher | undefined;
        if (workspaceRoot && buildTarget) {
          // The parent passes an already-absolute --bep-file; resolveBepPath also
          // handles a manual --serve invocation with a relative path (the child's
          // cwd is the parent's, not necessarily the workspace root).
          const bepPath = resolveBepPath(workspaceRoot, flags['bep-file']);
          watcher = startBepWatcher({
            bepPath,
            target: buildTarget,
            getClient: () => client,
            log: (msg) => console.error(`[lim] ${msg}`),
          });
        }
        // Close the watcher inside the tunnel teardown, BEFORE the tunnel/stack
        // are stopped, so an in-flight install never races a dead stack.
        await this.runTunnel(client, flags.port, watcher ? () => watcher.close() : undefined);
      });
      return;
    }

    // Resolve the Bazel workspace root before touching auth or instances:
    // `.limrun/` and the try-import must live at the workspace root, and failing
    // here avoids creating an instance when run outside a workspace. Walk up
    // like Bazel does, so the command works from any subdirectory.
    const workspaceRoot = findBazelWorkspaceRoot(process.cwd());
    if (!workspaceRoot) {
      this.error(
        'Not inside a Bazel workspace. Run `lim xcode rbe` from within the workspace you want ' +
          'to build (a directory tree containing MODULE.bazel, WORKSPACE, or WORKSPACE.bazel).',
      );
    }

    if (flags.stop) {
      await this.stopBackgroundTunnel(workspaceRoot);
      return;
    }

    // If a background tunnel is already running for this workspace, don't start a
    // second one (and don't fail with a cryptic "port in use"); point at --stop.
    const existing = readRbePidFile(workspaceRoot);
    if (existing && isProcessAlive(existing.pid)) {
      this.info(
        `A background tunnel is already running for this workspace (PID ${existing.pid}, ` +
          `grpc://127.0.0.1:${existing.port}).`,
      );
      this.info('Stop it with `lim xcode rbe --stop`, then re-run to start fresh.');
      return;
    }
    if (existing) {
      // Stale pid from a crashed/old tunnel. If it was an --ios daemon, its
      // simulator (an independent server-side instance) is still running and only
      // recorded here — reap it before dropping the pidfile, else it's orphaned.
      // If the delete fails, surface the id (the pidfile is gone after this) so
      // the user can clean it up; otherwise it idles out on its own.
      if (existing.simInstanceId) {
        if (await this.deleteSim(existing.simInstanceId)) {
          this.info(`Reaped the simulator ${existing.simInstanceId} from a previous tunnel.`);
        } else {
          this.info(
            `Could not delete the previous simulator ${existing.simInstanceId}; it will idle out on its own.`,
          );
        }
      }
      clearRbePidFile(workspaceRoot);
    }

    await this.withAuth(async () => {
      // The already-running guard above handles a tracked tunnel; if the port is
      // still busy here it's an orphan (pidfile gone) or another process, so
      // point at --stop in addition to --port.
      await assertLocalPortFree(flags.port).catch(() =>
        this.error(
          `Local port ${flags.port} is already in use. If a previous tunnel is still running, ` +
            'stop it with `lim xcode rbe --stop`; otherwise pass --port to choose another.',
        ),
      );

      // Resolve an instance and start the stack. An auto-resolved instance (no
      // --id) may be a stale cache pointer to an instance that still exists but
      // whose limbuild lacks /rbe; in that case drop it and create a fresh one
      // (once). A user-pinned --id is never silently swapped.
      let client!: XcodeClient;
      let instanceId!: string;
      let xcodeVersion!: string;
      for (let attempt = 0; ; attempt++) {
        const target = await this.resolveXcodeTargetOrCreate(flags.id);
        instanceId = typeof target === 'string' ? target : target.id;
        client = await this.resolveXcodeClient(target);

        // resolveXcodeClient validates an iOS-backed target via iosInstances.get,
        // but a cached standalone Xcode target is trusted without a round-trip.
        // Validate it so a stale "last instance" pointer or a deleted instance throws
        // NotFoundError here (→ withAuth clears the cache and recreates) rather than a
        // misleading /rbe 404. Skip an instance we created this run: create({wait:true})
        // already proved it exists, and get() reads the central read-model that the region
        // populates asynchronously, so validating it here would race that lag and tear down
        // a live session for nothing.
        if (typeof target !== 'string' && target.type === 'xcode' && !this.wasCreatedThisRun(instanceId)) {
          await this.client.xcodeInstances.get(instanceId);
        }

        // Start the stack (retrying transient gateway blips right after instance
        // creation) and poll to running. From here the stack may be (partially)
        // up: any failure before the tunnel owner takes over best-effort stops it
        // so we never leak a running stack with no client attached.
        this.reporter.start('Starting remote build execution');
        try {
          const initial = await retryTransient(() => client.startRbe(), {
            log: (m) => this.reporter.appendLog(m),
          });
          const status = await waitForRbeRunning(client, initial);
          xcodeVersion = status.xcodeVersion;
          this.reporter.stop('success', `Remote build execution ready (Xcode ${xcodeVersion})`);
          break;
        } catch (err) {
          this.reporter.stop('failure');
          if (err instanceof RbeUnsupportedError && !flags.id && attempt === 0) {
            // If WE just created this instance and it can't do RBE, delete it so
            // we don't leak a billed instance before creating a fresh one. A
            // pre-existing cached instance is only dropped from the cache below,
            // never deleted (the user may still want it).
            if (this.wasCreatedThisRun(instanceId)) {
              this.info(
                'The Xcode instance we created does not support remote build execution; replacing it...',
              );
              await this.deleteCreatedInstance(instanceId);
            } else {
              this.info(
                'That Xcode instance does not support remote build execution; creating a fresh one...',
              );
            }
            clearLastInstanceId(instanceId);
            continue;
          }
          await client.stopRbe().catch(() => {});
          // Best-effort: delete an instance we created this run before failing,
          // so a non-RbeUnsupported startup error doesn't leak it. No-op for a
          // user --id or a pre-existing cached instance.
          await this.deleteCreatedInstance(instanceId);
          this.error(err instanceof Error ? err.message : String(err));
        }
      }

      // Where Bazel writes its build event log and the watcher reads it: a custom
      // --bep-file (absolute) or the default under .limrun/.
      const bepPath = resolveBepPath(workspaceRoot, flags['bep-file']);

      let generated: RbeWorkspaceFiles;
      try {
        const besResultsUrl = this.consoleBazelBuildUrl(instanceId);
        generated = writeRbeWorkspaceFiles(workspaceRoot, xcodeVersion, flags.port, besResultsUrl, bepPath);
      } catch (err) {
        await client.stopRbe().catch(() => {});
        this.error(`Failed to generate .limrun config: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.reporter.success(
        `Generated .limrun/ config${generated.bazelrcUpdated ? ' (try-import wired into .bazelrc)' : ''}`,
      );

      // --digest_function=sha256 is required on Bazel 9 (BLAKE3 default) and on
      // any workspace configured for BLAKE3, and is a harmless no-op where SHA256
      // is already the default — so always emit it. It is a startup flag (can't
      // live in --config=limrun, and would change the digest for ALL the user's
      // builds if put in .bazelrc), hence it precedes `build` in the command.
      // Infer a real app target so the printed command is runnable as-is; fall
      // back to a placeholder when there's no single obvious target.
      const inferredTarget = inferBuildTarget(workspaceRoot);
      const target = inferredTarget ?? '//your:target';
      const buildCmd = `bazelisk --digest_function=sha256 build --config=limrun ${target}`;

      // Decide auto-install: on by default, but only when we have a concrete
      // target to watch. An explicit --target wins over inference; an ambiguous
      // workspace with no --target cannot auto-install.
      const watchTarget = flags.target ?? inferredTarget ?? undefined;
      const autoInstall = flags['auto-install'] && !!watchTarget;
      if (flags['auto-install'] && !watchTarget) {
        this.info(
          'Auto-install is off: could not infer a single app target. Pass --target <label> to enable it.',
        );
      }

      // --ios: create + attach a simulator so `lim xcode rbe install` installs on
      // it and the stream URL is printed. Recorded in the pidfile so --stop tears
      // it down too.
      let simInstanceId: string | undefined;
      if (flags.ios) {
        try {
          simInstanceId = await this.createAndAttachSimulator(client);
        } catch (err) {
          // The stack is already up; a simulator-setup failure must stop it, else
          // it keeps running with no tunnel or pidfile owner (createAndAttachSimulator
          // already deleted the sim itself on an attach failure).
          await client.stopRbe().catch(() => {});
          this.error(
            `Failed to set up the iOS simulator: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (flags.daemon) {
        try {
          await this.spawnBackgroundTunnel({
            client,
            simInstanceId,
            workspaceRoot,
            instanceId,
            port: flags.port,
            xcodeVersion,
            generated,
            buildCmd,
            autoInstall,
            target: autoInstall ? watchTarget : undefined,
            bepPath,
          });
        } catch (err) {
          // spawnBackgroundTunnel records simInstanceId in the pidfile only after
          // it confirms readiness; on a spawn/readiness failure nothing on disk
          // references the sim, so --stop could never reap it. Delete it here.
          await this.deleteSim(simInstanceId);
          throw err;
        }
        return;
      }

      // Foreground (--no-daemon): open the tunnel here, print, then block.
      this.reporter.start('Opening tunnel');
      let tunnel: Tunnel;
      try {
        tunnel = await this.openTunnel(client, flags.port);
      } catch (err) {
        this.reporter.stop('failure');
        await client.stopRbe().catch(() => {});
        // Foreground never writes a pidfile, so the sim created above can only be
        // reaped here; the steady-state finally below isn't reached on this path.
        await this.deleteSim(simInstanceId);
        this.error(
          `Failed to open the remote-execution tunnel: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.reporter.stop('success', `Tunnel open on grpc://127.0.0.1:${flags.port}`);
      this.printReady({
        port: flags.port,
        workspaceRoot,
        xcodeVersion,
        generated,
        buildCmd,
        instanceId,
        background: false,
      });
      // Foreground auto-install: watch the BEP for the lifetime of this tunnel.
      const watcher =
        autoInstall && watchTarget ?
          startBepWatcher({
            bepPath,
            target: watchTarget,
            getClient: () => client,
            log: (msg) => this.info(msg),
          })
        : undefined;
      try {
        // Close the watcher before the tunnel/stack teardown (inside awaitTunnel),
        // so an in-flight install never races a stopped stack.
        await this.awaitTunnel(tunnel, client, watcher ? () => watcher.close() : undefined);
      } finally {
        await this.deleteSim(simInstanceId);
      }
    });
  }

  /**
   * Stop the background tunnel recorded for this workspace. SIGTERM lets the
   * child close the tunnel and best-effort stop the remote stack; we then clear
   * the pidfile. No auth needed — this is a local process stop.
   */
  private async stopBackgroundTunnel(workspaceRoot: string): Promise<void> {
    const info = readRbePidFile(workspaceRoot);
    if (!info || !isProcessAlive(info.pid)) {
      // The daemon already died (crash, reboot, or `kill -9`). Its --ios sim is an
      // independent server-side instance, still running and recorded only in the
      // pidfile — reap it before clearing the pidfile, else it can never be reaped.
      // If the delete fails, surface the id (the pidfile is gone after this) so the
      // user can clean it up; otherwise it idles out on its own.
      if (info?.simInstanceId) {
        if (await this.deleteSim(info.simInstanceId)) {
          this.info(`Deleted the attached simulator ${info.simInstanceId}.`);
        } else {
          this.info(`Could not delete simulator ${info.simInstanceId}; it will idle out on its own.`);
        }
      }
      clearRbePidFile(workspaceRoot);
      this.info('No background tunnel is running in this workspace.');
      return;
    }
    this.reporter.start(`Stopping background tunnel (PID ${info.pid})`);

    // SIGTERM first: the child closes the tunnel and stops the remote stack via
    // DELETE /rbe, whose server-side teardown (tearing down the bb workers/store)
    // takes ~20s. Allow a generous grace so the stack is actually stopped rather
    // than orphaned to idle-out; the spinner keeps this from looking hung.
    const signalled = signalIfAlive(info.pid, 'SIGTERM');
    if (signalled) {
      for (let i = 0; i < 300 && isProcessAlive(info.pid); i++) {
        await defaultSleep(100); // up to ~30s for graceful teardown
      }
    }

    // Escalate to SIGKILL if it's wedged (e.g. stuck stopping the remote stack),
    // so --stop always frees the port instead of leaving an orphan.
    let forced = false;
    if (isProcessAlive(info.pid)) {
      forced = signalIfAlive(info.pid, 'SIGKILL');
      for (let i = 0; i < 20 && isProcessAlive(info.pid); i++) {
        await defaultSleep(100); // up to ~2s
      }
    }

    // Only drop the pidfile once the process is actually gone — otherwise a
    // re-run of --stop would wrongly report "no tunnel running" while the orphan
    // keeps holding the port.
    if (isProcessAlive(info.pid)) {
      this.reporter.stop('failure');
      this.error(`Tunnel process ${info.pid} did not exit. Force it with: kill -9 ${info.pid}`);
    }
    clearRbePidFile(workspaceRoot);
    if (forced) {
      this.reporter.stop('success', `Force-stopped background tunnel (PID ${info.pid})`);
      this.info(
        'It was killed before it could stop the remote stack; the instance will idle out on its own.',
      );
    } else {
      this.reporter.stop('success', `Stopped background tunnel (PID ${info.pid})`);
    }

    // Tear down the simulator `--ios` created (best-effort; needs auth, unlike
    // the local process stop above).
    if (info.simInstanceId) {
      if (await this.deleteSim(info.simInstanceId)) {
        this.info(`Deleted the attached simulator ${info.simInstanceId}.`);
      } else {
        this.info(`Could not delete simulator ${info.simInstanceId}; it will idle out on its own.`);
      }
    }
  }

  /**
   * Create an iOS simulator and attach it to the RBE Xcode instance, so
   * `lim xcode rbe install` installs on it and the user can watch it live. Prints
   * the stream URL and returns the new simulator's instance id (recorded in the
   * pidfile for --stop teardown).
   */
  private async createAndAttachSimulator(client: XcodeClient): Promise<string> {
    this.reporter.start('Creating iOS simulator');
    // The SDK creates + attaches and deletes the sim itself if attach fails, so we
    // never leak an orphan the pidfile never recorded.
    const { iosInstanceId, simulator } = await client.attachNewSimulator();
    this.reporter.stop('success', `Simulator ${iosInstanceId} created and attached`);
    const streamUrl = this.signedStreamUrl(simulator.status) ?? this.consoleStreamUrl(iosInstanceId);
    this.info(`Watch the simulator: ${streamUrl}`);
    return iosInstanceId;
  }

  /**
   * Best-effort delete of a simulator instance `--ios` created, so a failure
   * before the pidfile records it (or a teardown when the daemon is already gone)
   * doesn't leave a billed, un-reapable simulator. Never throws — cleanup must
   * not mask the original error or block a restart. Deletes directly rather than
   * through withAuth: a 404 (the sim already idled out, common at the stale-pid
   * reap) would otherwise trip withAuth's NotFound recovery and spawn a
   * replacement instance during cleanup — the opposite of the leak fix. If the
   * session has expired the delete just fails and the sim idles out on its own.
   * Returns whether the delete succeeded.
   */
  private async deleteSim(id: string | undefined): Promise<boolean> {
    if (!id) return false;
    try {
      await this.client.iosInstances.delete(id);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Spawn the detached child that holds the tunnel, redirect its output to
   * `.limrun/rbe.log`, confirm it came up, then print and return the terminal.
   */
  private async spawnBackgroundTunnel(opts: {
    client: XcodeClient;
    workspaceRoot: string;
    instanceId: string;
    simInstanceId?: string;
    port: number;
    xcodeVersion: string;
    generated: RbeWorkspaceFiles;
    buildCmd: string;
    autoInstall: boolean;
    target?: string;
    bepPath: string;
  }): Promise<void> {
    const apiKey = this.parsedFlags?.['api-key'] as string | undefined;
    const logPath = path.join(opts.workspaceRoot, LIMRUN_DIR, 'rbe.log');

    this.reporter.start('Starting background tunnel');
    const logFd = fs.openSync(logPath, 'w');
    const child = spawn(
      process.execPath,
      buildServeChildArgs({
        scriptPath: process.argv[1],
        id: opts.instanceId,
        port: opts.port,
        apiKey,
        // Pass the workspace + target (+ bep path) only when auto-install is on,
        // so the child starts the BEP watcher; otherwise it just holds the tunnel.
        ...(opts.autoInstall && opts.target ?
          { workspaceRoot: opts.workspaceRoot, target: opts.target, bepFile: opts.bepPath }
        : {}),
      }),
      { detached: true, stdio: ['ignore', logFd, logFd] },
    );
    fs.closeSync(logFd);
    child.unref();
    const pid = child.pid;
    if (pid === undefined) {
      await opts.client.stopRbe().catch(() => {});
      this.error('Failed to spawn the background tunnel process.');
    }

    // Readiness check: wait until the child's local listener actually accepts a
    // connection (startRbeTunnel binds the port only once openTunnel resolves),
    // rather than trusting a fixed delay — otherwise we'd advertise the endpoint
    // before it's bound and an immediate bazel run could hit connection-refused.
    // Loop exits on: port open (success), child exit (startup failure), or the
    // overall deadline (a child that never binds).
    let childExit: number | null | undefined;
    child.once('exit', (code) => {
      childExit = code ?? 0;
    });
    let ready = false;
    const deadline = Date.now() + 15000;
    while (childExit === undefined && Date.now() < deadline) {
      if (await probePortOpen(opts.port)) {
        ready = true;
        break;
      }
      await defaultSleep(200);
    }

    if (!ready) {
      this.reporter.stop('failure');
      await opts.client.stopRbe().catch(() => {});
      if (childExit !== undefined) {
        this.error(
          `The background tunnel exited during startup (code ${childExit}).\n` +
            `${readLogTail(logPath)}\nSee ${logPath} for details.`,
        );
      } else {
        // Alive but never bound the port within the deadline: reap it so it
        // doesn't linger holding nothing, then fail.
        signalIfAlive(pid, 'SIGKILL');
        this.error(
          `The background tunnel did not become ready on port ${opts.port} in time.\n` +
            `${readLogTail(logPath)}\nSee ${logPath} for details.`,
        );
      }
    }
    this.reporter.stop('success', `Tunnel running in background (PID ${pid})`);
    writeRbePidFile(opts.workspaceRoot, {
      pid,
      instanceId: opts.instanceId,
      port: opts.port,
      ...(opts.simInstanceId ? { simInstanceId: opts.simInstanceId } : {}),
      // Always record where the build event log is written (it follows --bep-file
      // regardless of auto-install), so `lim xcode rbe install` finds it even with
      // --no-auto-install. `target` is the watcher's, recorded only when watching.
      bepFile: opts.bepPath,
      ...(opts.autoInstall && opts.target ? { target: opts.target } : {}),
    });

    this.printReady({
      port: opts.port,
      workspaceRoot: opts.workspaceRoot,
      xcodeVersion: opts.xcodeVersion,
      generated: opts.generated,
      buildCmd: opts.buildCmd,
      instanceId: opts.instanceId,
      background: true,
      pid,
      logPath,
    });
  }

  /** Open the tunnel to the instance's RBE frontend. */
  private async openTunnel(client: XcodeClient, port: number): Promise<Tunnel> {
    return client.startRbeTunnel({
      port,
      logLevel: this.isJsonEnabled() || this.isQuietEnabled() ? 'none' : 'info',
    });
  }

  /**
   * Open the tunnel, then block until SIGINT/SIGTERM, closing the tunnel and
   * best-effort stopping the remote stack on exit. Used by the `--serve` child.
   *
   * Opening the tunnel happens BEFORE awaitTunnel's steady-state finally, so a
   * failure here must stop the stack itself: the parent detached and only reaps
   * the child if it exits within a short liveness window, so a slow tunnel-open
   * failure would otherwise leave the remote stack running with no owner.
   */
  private async runTunnel(
    client: XcodeClient,
    port: number,
    beforeStop?: () => Promise<void>,
  ): Promise<void> {
    let tunnel: Tunnel;
    try {
      tunnel = await this.openTunnel(client, port);
    } catch (err) {
      // The tunnel never opened, so there's no watcher steady state to drain, but
      // a watcher may already be running — close it before stopping the stack.
      if (beforeStop) await beforeStop().catch(() => {});
      await client.stopRbe().catch(() => {});
      this.error(
        `Failed to open the remote-execution tunnel: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await this.awaitTunnel(tunnel, client, beforeStop);
  }

  /**
   * Block on an already-open tunnel until a stop signal, then close it and
   * best-effort stop the remote stack. Rejects if the tunnel reports a terminal
   * disconnect (after its own reconnect attempts are exhausted).
   */
  private async awaitTunnel(
    tunnel: Tunnel,
    client: XcodeClient,
    beforeStop?: () => Promise<void>,
  ): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => {
        const keepAlive = setInterval(() => {}, 1 << 30);
        let stopping = false;
        const cleanup = () => {
          clearInterval(keepAlive);
          unsubscribe();
          process.off('SIGINT', shutdown);
          process.off('SIGTERM', shutdown);
        };
        const shutdown = () => {
          stopping = true;
          cleanup();
          this.info('Stopping the remote-execution tunnel...');
          resolve();
        };
        // The tunnel reconnects transient WS drops on its own; surface that as
        // status (once per outage) rather than letting bazel's retries look like a
        // hang, and only fail the session when reconnection is finally exhausted.
        let reconnectingNotified = false;
        const unsubscribe = tunnel.onConnectionStateChange((state) => {
          if (stopping) return;
          if (state === 'reconnecting') {
            if (!reconnectingNotified) {
              reconnectingNotified = true;
              this.warn('RBE tunnel lost; reconnecting...');
            }
            return;
          }
          if (state === 'connected') {
            if (reconnectingNotified) {
              reconnectingNotified = false;
              this.info('RBE tunnel reconnected.');
            }
            return;
          }
          if (state === 'disconnected') {
            cleanup();
            reject(
              new Error(
                'Remote-execution tunnel could not be re-established after repeated attempts ' +
                  '(the instance may have been torn down or lost connectivity). ' +
                  'Re-run `lim xcode rbe` to start a fresh tunnel.',
              ),
            );
          }
        });
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
      });
    } finally {
      // Drain the auto-install watcher first, so a registration in flight can't
      // land against an already-closed tunnel / stopped stack.
      if (beforeStop) await beforeStop().catch(() => {});
      tunnel.close();
      await client.stopRbe().catch(() => {});
    }
  }

  /** Print the ready banner (or JSON) for both foreground and background modes. */
  private printReady(opts: {
    port: number;
    workspaceRoot: string;
    xcodeVersion: string;
    generated: RbeWorkspaceFiles;
    buildCmd: string;
    instanceId: string;
    background: boolean;
    pid?: number;
    logPath?: string;
  }): void {
    if (this.isJsonEnabled()) {
      this.outputJson({
        instanceId: opts.instanceId,
        port: opts.port,
        xcodeVersion: opts.xcodeVersion,
        workspaceRoot: opts.workspaceRoot,
        generatedConfig: {
          buildFile: opts.generated.buildFile,
          bazelrcFragment: opts.generated.bazelrcFragment,
        },
        buildCommand: opts.buildCmd,
        ...(opts.background ? { pid: opts.pid, logPath: opts.logPath } : {}),
      });
      return;
    }

    // The build command goes to stdout (copy-paste friendly); status/checkmarks
    // already went to stderr via the reporter.
    this.output('');
    this.output('Build with:');
    this.output(`  ${opts.buildCmd}`);
    this.output('');
    this.output(`Endpoint:  grpc://127.0.0.1:${opts.port}`);
    if (opts.background) {
      this.output(`Logs:      ${opts.logPath}`);
      this.output(`Stop:      lim xcode rbe --stop   (or: kill ${opts.pid})`);
    } else {
      this.output('');
      this.info('Tunnel is running. Press Ctrl+C to stop.');
    }
    this.output('');
    this.info(
      'The built .ipa stays in the instance cache (install it with `lim xcode rbe install`); ' +
        'to download it to this machine, add --remote_download_outputs=toplevel to the build command.',
    );
  }
}

/** Sends `signal` to `pid`, ignoring "already gone". Returns false if the process was absent. */
function signalIfAlive(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Backstops the detached serve daemon. The auto-install watcher already catches
 * its own read/parse/HTTP errors internally, so a floating *rejection* here is
 * almost always benign (e.g. the tunnel's reconnect machinery); log and continue
 * rather than let Node's default crash drop the tunnel mid-build. A thrown
 * *exception* that reaches the top level is a genuine fault we can't reason
 * about: log and exit non-zero so the port frees and the next `lim xcode rbe`
 * reaps the stale pidfile — far better than lingering as a zombie that holds the
 * port with a dead tunnel and blocks restart.
 */
function installDaemonCrashGuards(log: (msg: string) => void): void {
  process.on('unhandledRejection', (reason) => {
    log(`auto-install: ignoring unhandled rejection to keep the tunnel alive: ${String(reason)}`);
  });
  process.on('uncaughtException', (err) => {
    log(`daemon: fatal uncaught exception, exiting so the tunnel can be restarted: ${err?.message ?? err}`);
    process.exit(1);
  });
}

/** Reads the last `lines` lines of a log file for error surfacing; best-effort. */
function readLogTail(logPath: string, lines = 20): string {
  try {
    const content = fs.readFileSync(logPath, 'utf8').trimEnd();
    if (!content) {
      return '(log file is empty)';
    }
    return content.split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log output captured)';
  }
}
