import fs from 'fs';
import net from 'net';
import path from 'path';
import { Flags } from '@oclif/core';
import type { Tunnel } from '@limrun/api';
import { BaseCommand } from '../../base-command';

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
      this.validateBazelWorkspace();
      await this.assertLocalPortFree(flags.port);

      const target = await this.resolveXcodeTargetOrCreate(flags.id);
      const client = await this.resolveXcodeClient(target);

      this.info('Starting the remote-execution stack...');
      let status = await client.startRbe();
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

        const bazelrc = [
          `build --remote_executor=grpc://127.0.0.1:${flags.port}`,
          'build --remote_default_exec_properties=OSFamily=Darwin',
          'build --spawn_strategy=remote',
          'build --noremote_local_fallback',
        ];

        if (flags.json) {
          this.outputJson({
            instanceId: typeof target === 'string' ? target : target.id,
            port: flags.port,
            frontendPort: status.frontendPort,
            bazelrc,
          });
        } else {
          this.output(`Remote execution endpoint ready: grpc://127.0.0.1:${flags.port}`);
          this.output('');
          this.output('Add to your .bazelrc (or pass as flags):');
          for (const line of bazelrc) {
            this.output(`  ${line}`);
          }
          this.output('');
          this.info(
            'Bazel bakes your local Xcode version into remote action keys; it must match the ' +
              "fleet's Xcode. If your local Xcode differs, configure --xcode_version_config to " +
              'declare the remotely available Xcode, otherwise remote actions will be rejected.',
          );
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
   * workspace root: bazel must run where MODULE.bazel or WORKSPACE lives for
   * the printed .bazelrc block to apply.
   */
  private validateBazelWorkspace(): void {
    const markers = ['MODULE.bazel', 'WORKSPACE', 'WORKSPACE.bazel'];
    const found = markers.some((m) => fs.existsSync(path.join(process.cwd(), m)));
    if (!found) {
      this.warn(
        'No MODULE.bazel or WORKSPACE found in the current directory. Run this command from the ' +
          'root of the Bazel workspace you want to build.',
      );
    }
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
