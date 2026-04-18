import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { detectInstanceType } from '../../lib/instance-client-factory';
import { isDaemonRunning, saveState, socketPath, type SessionState } from '../../lib/daemon';

export default class SessionStart extends BaseCommand {
  static summary = 'Start a persistent session for fast device interaction';
  static description =
    'Starts a background daemon that holds a WebSocket connection to the instance. ' +
    'All subsequent `exec` commands for this instance will route through the session for ~50ms latency instead of ~2s. ' +
    'Multiple sessions can run simultaneously for different instances.';

  static examples = [
    '<%= config.bin %> session start',
    '<%= config.bin %> session start --id ios_abc123',
    '<%= config.bin %> session start --id android_abc123',
  ];

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Instance ID to connect to. Defaults to the last created Android or iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SessionStart);
    this.setParsedFlags(flags);

    const id = this.resolveId(flags.id);

    if (isDaemonRunning(id)) {
      this.log(`Session already running for ${id}.`);
      return;
    }

    const type = detectInstanceType(id);
    if (type === 'xcode') {
      this.error(
        'Sessions are for device interaction (exec commands). Xcode instances use sync/build instead.',
      );
    }

    await this.withAuth(async () => {
      let apiUrl: string | undefined;
      let adbUrl: string | undefined;
      let token: string;

      if (type === 'android') {
        const instance = await this.client.androidInstances.get(id);
        apiUrl = instance.status.apiUrl;
        adbUrl = instance.status.adbWebSocketUrl;
        token = instance.status.token;
      } else {
        const instance = await this.client.iosInstances.get(id);
        apiUrl = instance.status.apiUrl;
        token = instance.status.token;
      }

      if (!apiUrl) {
        this.error(`Instance ${id} does not have an apiUrl. Is it ready?`);
      }

      const state: SessionState = {
        instanceId: id,
        instanceType: type,
        apiUrl,
        adbUrl,
        token,
      };
      saveState(id, state);

      // Spawn daemon with the instance ID as env var
      const daemonScript = path.join(__dirname, '..', '..', 'lib', 'daemon.js');
      const child = spawn(process.execPath, [daemonScript], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, LIM_DAEMON_INSTANCE_ID: id },
      });
      child.unref();

      // Wait for daemon to be ready
      const sock = socketPath(id);
      const startTime = Date.now();
      const timeout = 15000;

      await new Promise<void>((resolve, reject) => {
        child.on('error', reject);

        const check = () => {
          if (fs.existsSync(sock)) {
            resolve();
            return;
          }
          if (Date.now() - startTime > timeout) {
            reject(new Error('Daemon failed to start within 15 seconds'));
            return;
          }
          setTimeout(check, 100);
        };

        setTimeout(check, 100);
      });

      this.log(`Session started for ${id} (${type})`);
    });
  }
}
