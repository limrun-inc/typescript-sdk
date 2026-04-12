import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { detectInstanceType } from '../../lib/instance-client-factory';
import {
  isDaemonRunning,
  saveState,
  socketPath,
  sessionDir,
  type SessionState,
} from '../../lib/daemon';

export default class SessionStart extends BaseCommand {
  static summary = 'Start a persistent session for fast device interaction';
  static description =
    'Starts a background daemon that holds a WebSocket connection to the instance. ' +
    'All subsequent `exec` commands for this instance will route through the session for ~50ms latency instead of ~2s. ' +
    'Multiple sessions can run simultaneously for different instances.';

  static examples = [
    '<%= config.bin %> session start ios_abc123',
    '<%= config.bin %> session start android_abc123',
  ];

  static args = {
    id: Args.string({ description: 'Instance ID to connect to', required: true }),
  };

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SessionStart);
    this.setParsedFlags(flags);

    if (isDaemonRunning(args.id)) {
      this.log(`Session already running for ${args.id}.`);
      return;
    }

    const type = detectInstanceType(args.id);
    if (type === 'xcode') {
      this.error('Sessions are for device interaction (exec commands). Xcode instances use sync/build instead.');
    }

    await this.withAuth(async () => {
      let apiUrl: string | undefined;
      let adbUrl: string | undefined;
      let token: string;

      if (type === 'android') {
        const instance = await this.client.androidInstances.get(args.id);
        apiUrl = instance.status.apiUrl;
        adbUrl = instance.status.adbWebSocketUrl;
        token = instance.status.token;
      } else {
        const instance = await this.client.iosInstances.get(args.id);
        apiUrl = instance.status.apiUrl;
        token = instance.status.token;
      }

      if (!apiUrl) {
        this.error(`Instance ${args.id} does not have an apiUrl. Is it ready?`);
      }

      const state: SessionState = {
        instanceId: args.id,
        instanceType: type,
        apiUrl,
        adbUrl,
        token,
      };
      saveState(args.id, state);

      // Spawn daemon with the instance ID as env var
      const daemonScript = path.join(__dirname, '..', '..', 'lib', 'daemon.js');
      const child = spawn(process.execPath, [daemonScript], {
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, LIM_DAEMON_INSTANCE_ID: args.id },
      });
      child.unref();

      // Wait for daemon to be ready
      const sock = socketPath(args.id);
      const startTime = Date.now();
      const timeout = 15000;

      await new Promise<void>((resolve, reject) => {
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

        child.stderr?.on('data', () => {
          setTimeout(check, 50);
        });

        setTimeout(check, 200);
      });

      this.log(`Session started for ${args.id} (${type})`);
    });
  }
}
