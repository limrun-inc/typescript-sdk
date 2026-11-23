import { spawn } from 'node:child_process';

import { Flags } from '@oclif/core';
import { startArgentBridge } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import { getIosInstanceClient } from '../../lib/instance-client-factory';

// Argent installs as a .cmd wrapper on Windows, which spawn can only execute
// through a shell.
const argentSpawnOptions = { shell: process.platform === 'win32' } as const;

export default class IosArgent extends BaseCommand {
  static summary = 'Drive a running iOS instance with Argent';
  static description =
    'Start the locally installed Argent tool-server wired to a remote Limrun iOS simulator. ' +
    'The simulator then appears in Argent `list-devices` next to local devices, and Argent tools ' +
    'such as describe, screenshot, gesture-tap and launch-app drive it. The command stays running ' +
    'until Ctrl+C. Run your agent or `argent run` in another terminal with the same Argent install. ' +
    'A tool-server that is already running is replaced, because it must start with this wiring. ' +
    'Pass `argent server start` flags after `--`. Screen recording and native inspection tools are not supported.';
  static examples = [
    '<%= config.bin %> ios argent',
    '<%= config.bin %> ios argent --id <instance-ID>',
    '<%= config.bin %> ios argent -- --port 4000',
  ];

  static strict = false;

  static args = {};

  static flags = {
    'api-key': BaseCommand.baseFlags['api-key'],
    json: BaseCommand.baseFlags.json,
    quiet: BaseCommand.baseFlags.quiet,
    workspace: BaseCommand.baseFlags.workspace,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const parsed = await this.parse(IosArgent as any);
    const flags = parsed.flags as Record<string, any>;
    const passthroughArgs = (parsed.argv as string[]) ?? [];
    this.setParsedFlags(flags);

    await this.withAuth(
      async () => {
        const target = this.resolveIosInstance(flags.id);
        const { client, disconnect } = await getIosInstanceClient(this.client, target);
        try {
          const bridge = await startArgentBridge(client);
          try {
            if (flags.json) {
              this.outputJson({ instanceId: target.id, deviceId: bridge.deviceId });
            } else {
              this.output(bridge.deviceId);
              this.info(`${target.id} is available to Argent under the id above. Press Ctrl+C to stop.`);
            }
            const exitCode = await new Promise<number>((resolve, reject) => {
              // --force replaces a running tool-server: only one started with
              // the bridge environment resolves the xcrun shim.
              const proc = spawn('argent', ['server', 'start', '--force', ...passthroughArgs], {
                ...argentSpawnOptions,
                env: { ...process.env, ...bridge.env },
                stdio: ['inherit', 'pipe', 'inherit'],
              });
              // Argent's own output goes to stderr, so stdout stays the device id.
              proc.stdout?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
              let stopping = false;
              const stop = () => {
                stopping = true;
                proc.kill('SIGTERM');
              };
              process.once('SIGINT', stop);
              process.once('SIGTERM', stop);
              const cleanup = () => {
                process.off('SIGINT', stop);
                process.off('SIGTERM', stop);
              };
              proc.once('error', (error: NodeJS.ErrnoException) => {
                cleanup();
                reject(
                  error.code === 'ENOENT' ?
                    new Error(
                      'Failed to run `argent`. Install the Argent CLI first: npm install -g @swmansion/argent',
                    )
                  : error,
                );
              });
              proc.once('close', (code) => {
                cleanup();
                // A tool-server we stopped ourselves is a clean shutdown.
                resolve(stopping ? 0 : code ?? 1);
              });
            });
            if (exitCode !== 0) {
              this.exit(exitCode);
            }
          } finally {
            await bridge.close();
          }
        } finally {
          disconnect();
        }
      },
      // A replacement instance would not be the simulator the agent is driving.
      { createReplacement: false },
    );
  }
}
