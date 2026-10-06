import { setTimeout as sleep } from 'node:timers/promises';
import { Ios } from '@limrun/api';
import { startTcpTunnel, type Tunnel } from '@limrun/api/tunnel';

const apiUrl = process.env['LIM_IOS_API_URL'];
const token = process.env['LIM_IOS_TOKEN'];
if (!apiUrl || !token) throw new Error('Set LIM_IOS_API_URL and LIM_IOS_TOKEN from the iOS instance status.');

const ios = await Ios.createInstanceClient({ apiUrl, token });
let tunnel: Tunnel | undefined;
try {
  await ios.openUrl('https://example.com');

  // Safari's inspector socket may appear after openUrl returns.
  let socketPath: string | undefined;
  const deadline = Date.now() + 30_000;
  while (!socketPath && Date.now() < deadline) {
    socketPath = (await ios.lsof()).find((file) => file.path.endsWith('com.apple.webinspectord_sim.socket'))
      ?.path;
    if (!socketPath) await sleep(250);
  }
  if (!socketPath) throw new Error('Safari Web Inspector socket was not found within 30 seconds.');

  const url = new URL(`${apiUrl.replace(/\/$/, '')}/port-forward`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('socketPath', socketPath);

  tunnel = await startTcpTunnel(url.toString(), token, '127.0.0.1', 27753, { mode: 'multiplexed' });
  console.log(`Safari Web Inspector transport: ${tunnel.address.address}:${tunnel.address.port}`);
  console.log('Connect a Web Inspector protocol client to this TCP endpoint. Press Ctrl+C to stop.');

  await new Promise<void>((resolve, reject) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
    tunnel!.onConnectionStateChange((state) => {
      if (state === 'disconnected') reject(new Error('Web Inspector tunnel disconnected.'));
    });
  });
} finally {
  tunnel?.close();
  ios.disconnect();
}
