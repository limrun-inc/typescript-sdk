import { Args, Flags } from '@oclif/core';
import { Command } from '@oclif/core';
import { isDaemonRunning, getDaemonPid, clearSession, listActiveSessions } from '../../lib/daemon';

export default class SessionStop extends Command {
  static summary = 'Stop one or all active sessions';
  static description = 'Stops background daemons and disconnects from instances.';

  static examples = ['<%= config.bin %> session stop ios_abc123', '<%= config.bin %> session stop --all'];

  static args = {
    id: Args.string({ description: 'Instance ID to stop session for', required: false }),
  };

  static flags = {
    all: Flags.boolean({ description: 'Stop all active sessions', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SessionStop);

    if (flags.all) {
      const sessions = listActiveSessions();
      if (sessions.length === 0) {
        this.log('No active sessions.');
        return;
      }
      for (const s of sessions) {
        this.stopSession(s.instanceId, s.pid);
      }
      this.log(`Stopped ${sessions.length} session(s).`);
      return;
    }

    if (!args.id) {
      // If only one session, stop it. Otherwise ask for specificity.
      const sessions = listActiveSessions();
      if (sessions.length === 0) {
        this.log('No active sessions.');
        return;
      }
      if (sessions.length === 1) {
        this.stopSession(sessions[0].instanceId, sessions[0].pid);
        return;
      }
      this.log(`Multiple sessions active. Specify which to stop:`);
      for (const s of sessions) {
        this.log(`  ${s.instanceId} (pid ${s.pid})`);
      }
      this.log(`Or use --all to stop all.`);
      return;
    }

    if (!isDaemonRunning(args.id)) {
      this.log(`No active session for ${args.id}.`);
      return;
    }

    const pid = getDaemonPid(args.id);
    this.stopSession(args.id, pid);
  }

  private stopSession(instanceId: string, pid: number | null): void {
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
    clearSession(instanceId);
    this.log(`Session stopped for ${instanceId}.`);
  }
}
