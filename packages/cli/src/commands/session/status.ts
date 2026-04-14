import { BaseCommand } from '../../base-command';
import { listActiveSessions, loadState } from '../../lib/daemon';
import { sendCommand } from '../../lib/daemon-client';
import { loadInstanceCache } from '../../lib/config';

export default class SessionStatus extends BaseCommand {
  static summary = 'Show active sessions';
  static examples = ['<%= config.bin %> session status'];

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { flags } = await this.parse(SessionStatus);
    this.setParsedFlags(flags);

    const sessions = listActiveSessions();

    if (flags.json) {
      const details = [];
      for (const s of sessions) {
        const state = loadState(s.instanceId);
        const cache = loadInstanceCache(s.instanceId);
        let connected = false;
        try {
          const status = (await sendCommand(s.instanceId, 'status')) as any;
          connected = status.connected;
        } catch {}
        details.push({
          instanceId: s.instanceId,
          pid: s.pid,
          type: state?.instanceType,
          connected,
          xcodeSandbox: cache?.sandboxXcodeUrl || null,
        });
      }
      this.outputJson(details);
      return;
    }

    if (sessions.length === 0) {
      this.log('No active sessions.');
      this.log('Start one with: lim session start --id <instance-ID>');
      return;
    }

    this.log(`${sessions.length} active session(s):\n`);
    for (const s of sessions) {
      const state = loadState(s.instanceId);
      this.log(`  ${s.instanceId}`);
      this.log(`    PID:  ${s.pid}`);
      if (state) {
        this.log(`    Type: ${state.instanceType}`);
      }
      const cache = loadInstanceCache(s.instanceId);
      if (cache?.sandboxXcodeUrl) {
        this.log(`    Xcode: ${cache.sandboxXcodeUrl}`);
      }
      try {
        const status = (await sendCommand(s.instanceId, 'status')) as any;
        this.log(`    Connected: ${status.connected}`);
      } catch {}
      this.log('');
    }
  }
}
