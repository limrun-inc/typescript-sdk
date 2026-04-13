import net from 'net';
import { socketPath, isDaemonRunning, type DaemonRequest, type DaemonResponse } from './daemon';

/**
 * Check if a daemon session is active for the given instance ID.
 */
export function isSessionActive(instanceId: string): boolean {
  return isDaemonRunning(instanceId);
}

/**
 * Send a command to the daemon for the given instance ID and collect the result.
 */
export async function sendCommand(
  instanceId: string,
  command: string,
  args: unknown[] = [],
): Promise<unknown> {
  if (!isDaemonRunning(instanceId)) {
    throw new Error(`No active session for ${instanceId}. Run \`lim session start ${instanceId}\` first.`);
  }

  const sock = socketPath(instanceId);

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sock);
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
      reject(new Error(`Failed to connect to daemon for ${instanceId}: ${err.message}`));
    });

    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Daemon request timed out'));
    });

    socket.setTimeout(30000);
  });
}
