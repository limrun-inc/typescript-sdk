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
    serve: Flags.boolean({
      hidden: true,
      default: false,
      description: 'Internal: run only the tunnel serve loop (used by the detached background process).',
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
      await this.withAuth(async () => {
        const target = await this.resolveXcodeTarget(flags.id);
        const client = await this.resolveXcodeClient(target);
        await this.runTunnel(client, flags.port);
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
      clearRbePidFile(workspaceRoot); // stale pid from a crashed/old tunnel
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
        // Validate it so a deleted instance throws NotFoundError here (→ withAuth
        // clears the cache and recreates) rather than a misleading /rbe 404.
        if (typeof target !== 'string' && target.type === 'xcode') {
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
            this.info('That Xcode instance does not support remote build execution; creating a fresh one...');
            clearLastInstanceId(instanceId);
            continue;
          }
          await client.stopRbe().catch(() => {});
          this.error(err instanceof Error ? err.message : String(err));
        }
      }

      let generated: RbeWorkspaceFiles;
      try {
        generated = writeRbeWorkspaceFiles(workspaceRoot, xcodeVersion, flags.port);
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
      const target = inferBuildTarget(workspaceRoot) ?? '//your:target';
      const buildCmd = `bazelisk --digest_function=sha256 build --config=limrun ${target}`;

      if (flags.daemon) {
        await this.spawnBackgroundTunnel({
          client,
          workspaceRoot,
          instanceId,
          port: flags.port,
          xcodeVersion,
          generated,
          buildCmd,
        });
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
      await this.awaitTunnel(tunnel, client);
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
  }

  /**
   * Spawn the detached child that holds the tunnel, redirect its output to
   * `.limrun/rbe.log`, confirm it came up, then print and return the terminal.
   */
  private async spawnBackgroundTunnel(opts: {
    client: XcodeClient;
    workspaceRoot: string;
    instanceId: string;
    port: number;
    xcodeVersion: string;
    generated: RbeWorkspaceFiles;
    buildCmd: string;
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
    writeRbePidFile(opts.workspaceRoot, { pid, instanceId: opts.instanceId, port: opts.port });

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
  private async runTunnel(client: XcodeClient, port: number): Promise<void> {
    let tunnel: Tunnel;
    try {
      tunnel = await this.openTunnel(client, port);
    } catch (err) {
      await client.stopRbe().catch(() => {});
      this.error(
        `Failed to open the remote-execution tunnel: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await this.awaitTunnel(tunnel, client);
  }

  /**
   * Block on an already-open tunnel until a stop signal, then close it and
   * best-effort stop the remote stack. Rejects if the tunnel reports a terminal
   * disconnect (after its own reconnect attempts are exhausted).
   */
  private async awaitTunnel(tunnel: Tunnel, client: XcodeClient): Promise<void> {
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
        const unsubscribe = tunnel.onConnectionStateChange((state) => {
          if (state === 'disconnected' && !stopping) {
            cleanup();
            reject(new Error('Remote-execution tunnel disconnected unexpectedly'));
          }
        });
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
      });
    } finally {
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
