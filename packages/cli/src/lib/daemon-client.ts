import net from 'net';
import {
  SOCKET_PATH,
  isDaemonRunning,
  type DaemonRequest,
  type DaemonResponse,
} from './daemon';

/**
 * Check if a daemon session is active and available.
 */
export function isSessionActive(): boolean {
  return isDaemonRunning();
}

/**
 * Send a command to the running daemon and collect the result.
 * Returns the result data from the daemon, or throws on error.
 */
export async function sendCommand(command: string, args: unknown[] = []): Promise<unknown> {
  if (!isDaemonRunning()) {
    throw new Error('No active session. Run `lim session start <ID>` first.');
  }

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);
    let buffer = '';
    let resultData: unknown = undefined;
    let errorMsg: string | undefined;

    socket.on('connect', () => {
      const req: DaemonRequest = { command, args };
      socket.write(JSON.stringify(req) + '\n');
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;

        let resp: DaemonResponse;
        try {
          resp = JSON.parse(line);
        } catch {
          continue;
        }

        switch (resp.type) {
          case 'result':
            resultData = resp.data;
            break;
          case 'stdout':
            if (resp.data) process.stdout.write(String(resp.data) + '\n');
            break;
          case 'stderr':
            errorMsg = String(resp.data);
            break;
          case 'done':
            socket.end();
            if (resp.exitCode !== 0 && errorMsg) {
              reject(new Error(errorMsg));
            } else {
              resolve(resultData);
            }
            return;
        }
      }
    });

    socket.on('error', (err) => {
      reject(new Error(`Failed to connect to daemon: ${err.message}`));
    });

    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Daemon request timed out'));
    });

    socket.setTimeout(30000); // 30s timeout for any command
  });
}
