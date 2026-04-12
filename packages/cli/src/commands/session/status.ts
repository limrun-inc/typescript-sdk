import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { isDaemonRunning, getDaemonPid, loadState } from '../../lib/daemon';
import { sendCommand } from '../../lib/daemon-client';
import { loadInstanceCache } from '../../lib/config';

export default class SessionStatus extends BaseCommand {
  static summary = 'Show active session status';
  static examples = ['<%= config.bin %> session status'];

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { flags } = await this.parse(SessionStatus);
    this.setParsedFlags(flags);

    const running = isDaemonRunning();
    const state = loadState();
    const pid = getDaemonPid();

    if (flags.json) {
      if (running) {
        try {
          const daemonStatus = await sendCommand('status');
          this.outputJson(daemonStatus);
        } catch {
          this.outputJson({ running, pid, state });
        }
      } else {
        this.outputJson({ running: false, state: null });
      }
      return;
    }

    if (!running) {
      this.log('No active session.');
      this.log('Start one with: lim session start <instance-ID>');
      return;
    }

    this.log(`Session active`);
    this.log(`  Daemon PID: ${pid}`);
    if (state) {
      this.log(`  Instance:   ${state.instanceId}`);
      this.log(`  Type:       ${state.instanceType}`);

      const cache = loadInstanceCache(state.instanceId);
      if (cache?.sandboxXcodeUrl) {
        this.log(`  Xcode:      ${cache.sandboxXcodeUrl}`);
      }
    }

    try {
      const status = (await sendCommand('status')) as any;
      this.log(`  Connected:  ${status.connected}`);
    } catch {}
  }
}
