import net from 'net';
import { Flags } from '@oclif/core';
import type { Tunnel } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import {
  detectBazelMajorVersion,
  findBazelWorkspaceRoot,
  isBazel9OrLater,
  writeRbeWorkspaceFiles,
} from '../../lib/rbe-workspace';

export default class XcodeRbe extends BaseCommand {
  static summary = 'Serve a local Bazel remote-execution endpoint backed by a Limrun Xcode instance';
  static description =
    'Start the embedded Bazel Remote Build Execution stack on an Xcode instance and bridge it to a ' +
    'local TCP port. Point bazel at it with --remote_executor=grpc://127.0.0.1:<port> and actions ' +
    'execute on the remote macOS instance. Run from the root of a Bazel workspace. The tunnel stays ' +
    'open until Ctrl+C; the remote stack is stopped on exit.';
  static examples = [
    '<%= config.bin %> xcode rbe',
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
      default: 8980,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(XcodeRbe);
    this.setParsedFlags(flags);

    // Resolve the Bazel workspace root before doing anything with auth or
    // instances: `.limrun/` and the try-import must live at the workspace root
    // (where bazelrc's %workspace% resolves), and failing here avoids creating
    // an instance when the command is run outside a workspace. Walk up like
    // Bazel itself does, so the command works from any subdirectory.
    const workspaceRoot = findBazelWorkspaceRoot(process.cwd());
    if (!workspaceRoot) {
      this.error(
        'Not inside a Bazel workspace. Run `lim xcode rbe` from within the workspace you want ' +
          'to build (a directory tree containing MODULE.bazel, WORKSPACE, or WORKSPACE.bazel).',
      );
    }

    await this.withAuth(async () => {
      await this.assertLocalPortFree(flags.port);

      const target = await this.resolveXcodeTargetOrCreate(flags.id);
      const client = await this.resolveXcodeClient(target);

      this.info('Starting the remote-execution stack...');
      // Retry transient gateway failures: right after an instance is created
      // (or replaced), the proxy can report ready a beat before limbuild fully
      // serves, so the first POST occasionally fails with 502/EOF. startRbe is
      // idempotent, making blind retries safe.
      let status = await this.retryTransient(() => client.startRbe());
      for (let attempt = 0; status.state === 'starting' && attempt < 15; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        status = await client.getRbe();
      }
      if (status.state !== 'running' || !status.frontendPort || !status.xcodeVersion) {
        this.error(`Remote-execution stack failed to start: ${status.error ?? `state is ${status.state}`}`);
      }
      const xcodeVersion = status.xcodeVersion;

      let tunnel: Tunnel | undefined;
      try {
        try {
          tunnel = await client.startRbeTunnel({
            port: flags.port,
            logLevel: flags.json || flags.quiet ? 'none' : 'info',
          });
        } catch (err) {
          this.error(
            `Failed to open the remote-execution tunnel: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        // Generate the workspace companion at the workspace root (.limrun/BUILD
        // pinning the fleet Xcode, .limrun/bazelrc with the flags under
        // --config=limrun, try-import wiring) so builds need no manual config
        // and survive fleet Xcode upgrades.
        const generated = writeRbeWorkspaceFiles(workspaceRoot, xcodeVersion, flags.port);
        // Bazel 9 defaults to BLAKE3 but the limrun cache only speaks SHA256;
        // --digest_function is a STARTUP flag so it can't be scoped to
        // --config=limrun in the generated rc — surface it as a hint instead.
        const needsSha256 = isBazel9OrLater(detectBazelMajorVersion(workspaceRoot));
        const buildCmd =
          needsSha256 ?
            'bazelisk --digest_function=sha256 build --config=limrun //your:target'
          : 'bazelisk build --config=limrun //your:target';

        if (flags.json) {
          this.outputJson({
            instanceId: typeof target === 'string' ? target : target.id,
            port: flags.port,
            frontendPort: status.frontendPort,
            xcodeVersion,
            workspaceRoot,
            generatedConfig: { buildFile: generated.buildFile, bazelrcFragment: generated.bazelrcFragment },
            buildCommand: buildCmd,
          });
        } else {
          this.output(`Remote execution endpoint ready: grpc://127.0.0.1:${flags.port}`);
          this.output('');
          this.info(
            `Generated .limrun/ config in ${workspaceRoot} for the fleet's Xcode ${xcodeVersion}` +
              (generated.bazelrcUpdated ? ' and wired try-import into .bazelrc.' : '.'),
          );
          this.output('Build with:');
          this.output(`  ${buildCmd}`);
          if (needsSha256) {
            this.info(
              'Bazel 9 defaults to BLAKE3; the limrun cache currently requires SHA256, ' +
                'so the --digest_function=sha256 startup flag above is required.',
            );
          }
          this.output('');
          this.info('Tunnel started. Press Ctrl+C to stop.');
        }

        const activeTunnel: Tunnel = tunnel;
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
          const unsubscribe = activeTunnel.onConnectionStateChange((state) => {
            if (state === 'disconnected' && !stopping) {
              cleanup();
              reject(new Error('Remote-execution tunnel disconnected unexpectedly'));
            }
          });
          process.once('SIGINT', shutdown);
          process.once('SIGTERM', shutdown);
        });
      } finally {
        tunnel?.close();
        await client.stopRbe().catch(() => {});
      }
    });
  }


  /**
   * Retries fn on transient gateway errors (502/503/504 or dropped
   * connections), which occur when an instance was just created and its proxy
   * path is not fully serving yet. Non-transient errors propagate immediately.
   */
  private async retryTransient<T>(fn: () => Promise<T>): Promise<T> {
    const transient = /\b(502|503|504)\b|EOF|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed/i;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!transient.test(message)) {
          throw err;
        }
        lastErr = err;
        if (attempt < 5) {
          this.info(`Instance not serving yet (${message.trim()}); retrying...`);
          await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        }
      }
    }
    throw lastErr;
  }

  /** Fail fast with a helpful message when the local port is already taken. */
  private async assertLocalPortFree(port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Local port ${port} is already in use. Pass --port to choose another.`));
        } else {
          reject(err);
        }
      });
      probe.once('listening', () => {
        probe.close(() => resolve());
      });
      probe.listen(port, '127.0.0.1');
    }).catch((err) => this.error(err instanceof Error ? err.message : String(err)));
  }
}
