import { setTimeout as sleep } from 'node:timers/promises';
import { Ios, Limrun } from '@limrun/api';
import { startTcpTunnel, type Tunnel } from '@limrun/api/tunnel';

const apiKey = process.env['LIM_API_KEY'];
if (!apiKey) throw new Error('Set LIM_API_KEY to your Limrun API key.');

const stopped = new Promise<void>((resolve) => {
  process.once('SIGINT', () => resolve());
  process.once('SIGTERM', () => resolve());
});
const limrun = new Limrun({ apiKey });
const instance = await limrun.iosInstances.create({ wait: true });
console.log(`Created instance ${instance.metadata.id}`);
let ios: Ios.InstanceClient | undefined;
let tunnel: Tunnel | undefined;
try {
  const { apiUrl, token } = instance.status;
  if (!apiUrl || !token) throw new Error('Instance is missing its API URL or token.');
  ios = await Ios.createInstanceClient({ apiUrl, token });
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

  await Promise.race([
    stopped,
    new Promise<never>((_, reject) => {
      tunnel!.onConnectionStateChange((state) => {
        if (state === 'disconnected') reject(new Error('Web Inspector tunnel disconnected.'));
      });
    }),
  ]);
} finally {
  tunnel?.close();
  ios?.disconnect();
  await limrun.iosInstances.delete(instance.metadata.id);
  console.log(`Deleted instance ${instance.metadata.id}`);
}
