import fs from 'fs';
import net from 'net';
import path from 'path';
import { Flags } from '@oclif/core';
import type { Tunnel } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import { writeRbeWorkspaceFiles } from '../../lib/rbe-workspace';

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

    await this.withAuth(async () => {
      const isBazelWorkspace = this.validateBazelWorkspace();
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
      if (status.state !== 'running' || !status.frontendPort) {
        this.error(`Remote-execution stack failed to start: ${status.error ?? `state is ${status.state}`}`);
      }

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

        const shortXcode = status.xcodeVersion ? status.xcodeVersion.split('.').slice(0, 2).join('.') : undefined;
        const isMacClient = process.platform === 'darwin';
        const bazelrc = [
          `build --remote_executor=grpc://127.0.0.1:${flags.port}`,
          'build --remote_default_exec_properties=OSFamily=Darwin',
          'build --spawn_strategy=remote',
          'build --noremote_local_fallback',
          'build --strategy=SwiftCompile=remote',
          'build --strategy=Genrule=remote',
          ...(shortXcode ? [`build --xcode_version=${shortXcode}`] : []),
          // Non-mac clients have no auto-detected darwin exec platform; on a mac
          // this flag is harmful (it pulls exec-config actions onto the host).
          ...(isMacClient ?
            []
          : ['build --extra_execution_platforms=@build_bazel_apple_support//platforms:darwin_arm64']),
          'build --action_env=PATH=/usr/bin:/bin:/usr/sbin:/sbin',
        ];

        // With the fleet's Xcode version in hand, generate the workspace
        // companion (.limrun/BUILD pinning the version, .limrun/bazelrc with
        // the flags under --config=limrun, try-import wiring) so builds need
        // no manual configuration and survive fleet Xcode upgrades.
        let generated: ReturnType<typeof writeRbeWorkspaceFiles> | undefined;
        if (isBazelWorkspace && status.xcodeVersion) {
          generated = writeRbeWorkspaceFiles(process.cwd(), status.xcodeVersion, flags.port);
        }

        if (flags.json) {
          this.outputJson({
            instanceId: typeof target === 'string' ? target : target.id,
            port: flags.port,
            frontendPort: status.frontendPort,
            xcodeVersion: status.xcodeVersion,
            generatedConfig:
              generated ?
                { buildFile: generated.buildFile, bazelrcFragment: generated.bazelrcFragment }
              : undefined,
            bazelrc,
          });
        } else {
          this.output(`Remote execution endpoint ready: grpc://127.0.0.1:${flags.port}`);
          this.output('');
          if (generated) {
            this.info(
              `Generated .limrun/ config for the fleet's Xcode ${status.xcodeVersion}` +
                (generated.bazelrcUpdated ? ' and wired try-import into .bazelrc.' : '.'),
            );
            this.output('Build with:');
            this.output('  bazelisk build --config=limrun //your:target');
          } else {
            this.output('Add to your .bazelrc (or pass as flags):');
            for (const line of bazelrc) {
              this.output(`  ${line}`);
            }
            if (status.xcodeVersion) {
              this.info(
                `The fleet runs Xcode ${status.xcodeVersion}; declare it with an xcode_version_config ` +
                  'target or remote actions from a different local Xcode will be rejected.',
              );
            }
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
   * Warn (and continue) when the current directory does not look like a Bazel
   * workspace root: bazel must run where MODULE.bazel or WORKSPACE lives, and
   * the generated .limrun/ config is only written into a real workspace.
   */
  private validateBazelWorkspace(): boolean {
    const markers = ['MODULE.bazel', 'WORKSPACE', 'WORKSPACE.bazel'];
    const found = markers.some((m) => fs.existsSync(path.join(process.cwd(), m)));
    if (!found) {
      this.warn(
        'No MODULE.bazel or WORKSPACE found in the current directory. Run this command from the ' +
          'root of the Bazel workspace you want to build.',
      );
    }
    return found;
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
