import { Flags } from '@oclif/core';
import { Command } from '@oclif/core';
import { isDaemonRunning, getDaemonPid, clearSession, listActiveSessions } from '../../lib/daemon';

export default class SessionStop extends Command {
  static summary = 'Stop one or all active sessions';
  static description =
    'Stop a single background session daemon or all active session daemons. If you omit `--id` and only one session is running, that session is stopped automatically.';

  static examples = [
    '<%= config.bin %> session stop',
    '<%= config.bin %> session stop --id ios_abc123',
    '<%= config.bin %> session stop --all',
  ];

  static args = {};

  static flags = {
    id: Flags.string({
      description:
        'Instance ID whose session should be stopped. If omitted, the command can auto-select the only active session.',
    }),
    all: Flags.boolean({
      description: 'Stop all active sessions instead of a single instance session',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SessionStop);

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

    if (!flags.id) {
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

    if (!isDaemonRunning(flags.id)) {
      this.log(`No active session for ${flags.id}.`);
      return;
    }

    const pid = getDaemonPid(flags.id);
    this.stopSession(flags.id, pid);
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
