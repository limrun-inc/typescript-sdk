import { Command } from '@oclif/core';
import { isDaemonRunning, getDaemonPid, clearState } from '../../lib/daemon';

export default class SessionStop extends Command {
  static summary = 'Stop the active session';
  static description = 'Stops the background daemon and disconnects from the instance.';

  static examples = ['<%= config.bin %> session stop'];

  async run(): Promise<void> {
    if (!isDaemonRunning()) {
      this.log('No active session.');
      return;
    }

    const pid = getDaemonPid();
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
        this.log(`Session stopped (daemon pid ${pid}).`);
      } catch {
        this.log('Daemon process already gone. Cleaning up.');
      }
    }

    clearState();
  }
}
