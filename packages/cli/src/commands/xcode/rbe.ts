import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { Flags } from '@oclif/core';
import type { Tunnel, XcodeClient } from '@limrun/api';
import { DEFAULT_RBE_TUNNEL_PORT } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import {
  detectBazelMajorVersion,
  findBazelWorkspaceRoot,
  isBazel9OrLater,
  writeRbeWorkspaceFiles,
  LIMRUN_DIR,
  type RbeWorkspaceFiles,
} from '../../lib/rbe-workspace';
import {
  assertLocalPortFree,
  buildServeChildArgs,
  retryTransient,
  waitForRbeRunning,
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
    serve: Flags.boolean({
      hidden: true,
      default: false,
      description: 'Internal: run only the tunnel serve loop (used by the detached background process).',
    }),
  };

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

    await this.withAuth(async () => {
      await assertLocalPortFree(flags.port).catch((err) =>
        this.error(err instanceof Error ? err.message : String(err)),
      );

      const target = await this.resolveXcodeTargetOrCreate(flags.id);
      const instanceId = typeof target === 'string' ? target : target.id;
      const client = await this.resolveXcodeClient(target);

      this.info('Starting the remote-execution stack...');
      // Retry transient gateway failures: right after an instance is created
      // (or replaced), the proxy can report ready a beat before limbuild fully
      // serves, so the first POST occasionally fails with 502/EOF. startRbe is
      // idempotent, making blind retries safe.
      const initial = await retryTransient(() => client.startRbe(), { log: (m) => this.info(m) });

      // From here the stack may be (partially) up: any failure before the tunnel
      // owner takes over must best-effort stop it so we never leak a running
      // stack with no client attached.
      const xcodeVersion = await this.prepareOrCleanup(client, initial);
      const generated = await this.generateOrCleanup(client, workspaceRoot, xcodeVersion, flags.port);

      const needsSha256 = isBazel9OrLater(detectBazelMajorVersion(workspaceRoot));
      const buildCmd =
        needsSha256 ?
          'bazelisk --digest_function=sha256 build --config=limrun //your:target'
        : 'bazelisk build --config=limrun //your:target';

      if (flags.daemon) {
        await this.spawnBackgroundTunnel({
          client,
          workspaceRoot,
          instanceId,
          port: flags.port,
          xcodeVersion,
          generated,
          buildCmd,
          needsSha256,
        });
        return;
      }

      // Foreground (--no-daemon): open the tunnel here, print, then block.
      let tunnel: Tunnel;
      try {
        tunnel = await this.openTunnel(client, flags.port);
      } catch (err) {
        await client.stopRbe().catch(() => {});
        this.error(
          `Failed to open the remote-execution tunnel: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.printReady({
        port: flags.port,
        workspaceRoot,
        xcodeVersion,
        generated,
        buildCmd,
        needsSha256,
        instanceId,
        frontendPort: initial.frontendPort,
        background: false,
      });
      await this.awaitTunnel(tunnel, client);
    });
  }

  /** Poll the stack to running; stop it and exit on failure (fixes the cleanup gap). */
  private async prepareOrCleanup(
    client: XcodeClient,
    initial: Awaited<ReturnType<XcodeClient['startRbe']>>,
  ): Promise<string> {
    try {
      const status = await waitForRbeRunning(client, initial);
      return status.xcodeVersion;
    } catch (err) {
      await client.stopRbe().catch(() => {});
      this.error(err instanceof Error ? err.message : String(err));
    }
  }

  /** Generate `.limrun/`; stop the stack and exit on failure. */
  private async generateOrCleanup(
    client: XcodeClient,
    workspaceRoot: string,
    xcodeVersion: string,
    port: number,
  ): Promise<RbeWorkspaceFiles> {
    try {
      return writeRbeWorkspaceFiles(workspaceRoot, xcodeVersion, port);
    } catch (err) {
      await client.stopRbe().catch(() => {});
      this.error(
        `Failed to generate .limrun config: ${err instanceof Error ? err.message : String(err)}`,
      );
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
    needsSha256: boolean;
  }): Promise<void> {
    const apiKey = this.parsedFlags?.['api-key'] as string | undefined;
    const logPath = path.join(opts.workspaceRoot, LIMRUN_DIR, 'rbe.log');
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

    // Liveness check (no tunnel side effects): race an early `exit` against a
    // short timer. If the child dies on startup, surface its log and stop the
    // stack so we don't leak it.
    const early = await new Promise<number | null | undefined>((resolve) => {
      const timer = setTimeout(() => {
        child.off('exit', onExit);
        resolve(undefined);
      }, 1500);
      const onExit = (code: number | null) => {
        clearTimeout(timer);
        resolve(code);
      };
      child.once('exit', onExit);
    });
    if (early !== undefined) {
      await opts.client.stopRbe().catch(() => {});
      this.error(
        `The background tunnel exited immediately (code ${early ?? 'null'}).\n` +
          `${readLogTail(logPath)}\nSee ${logPath} for details.`,
      );
    }

    this.printReady({
      port: opts.port,
      workspaceRoot: opts.workspaceRoot,
      xcodeVersion: opts.xcodeVersion,
      generated: opts.generated,
      buildCmd: opts.buildCmd,
      needsSha256: opts.needsSha256,
      instanceId: opts.instanceId,
      frontendPort: undefined,
      background: true,
      pid: child.pid,
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
   */
  private async runTunnel(client: XcodeClient, port: number): Promise<void> {
    const tunnel = await this.openTunnel(client, port);
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
    needsSha256: boolean;
    instanceId: string;
    frontendPort?: number;
    background: boolean;
    pid?: number;
    logPath?: string;
  }): void {
    if (this.isJsonEnabled()) {
      this.outputJson({
        instanceId: opts.instanceId,
        port: opts.port,
        frontendPort: opts.frontendPort,
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

    this.output(`Remote execution endpoint ready: grpc://127.0.0.1:${opts.port}`);
    this.output('');
    this.info(
      `Generated .limrun/ config in ${opts.workspaceRoot} for the fleet's Xcode ${opts.xcodeVersion}` +
        (opts.generated.bazelrcUpdated ? ' and wired try-import into .bazelrc.' : '.'),
    );
    this.output('Build with:');
    this.output(`  ${opts.buildCmd}`);
    if (opts.needsSha256) {
      this.info(
        'Bazel 9 defaults to BLAKE3; the limrun cache currently requires SHA256, ' +
          'so the --digest_function=sha256 startup flag above is required.',
      );
    }
    this.output('');
    if (opts.background) {
      this.info(`Tunnel running in background (PID ${opts.pid}).`);
      this.info('Stop it by either killing the process or deleting the instance:');
      this.info(`  kill ${opts.pid}`);
      this.info(`  lim xcode delete ${opts.instanceId}`);
      if (opts.logPath) {
        this.info(`Logs: ${opts.logPath}`);
      }
    } else {
      this.info('Tunnel started. Press Ctrl+C to stop.');
    }
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
