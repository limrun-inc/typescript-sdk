import { DestinationTunnelHARAssembler, Limrun, createInstanceClient } from '@limrun/api';

const apiKey = process.env['LIM_API_KEY'];

if (!apiKey) {
  console.error('Error: Missing required environment variables (LIM_API_KEY).');
  process.exit(1);
}

const limrun = new Limrun({ apiKey });

// Wait makes sure the request returns only after the URLs are set and
// the instance is ready to connect.
console.time('create');
const androidInstance = await limrun.androidInstances.create({ wait: true });
console.log(`Instance ${androidInstance.metadata.id} created`);
console.timeEnd('create');

if (!androidInstance.status.apiUrl || !androidInstance.status.adbWebSocketUrl) {
  throw new Error('Missing apiUrl or adbWebSocketUrl on Android instance');
}
const client = await createInstanceClient({
  apiUrl: androidInstance.status.apiUrl,
  adbUrl: androidInstance.status.adbWebSocketUrl,
  token: androidInstance.status.token,
});

const assembler = new DestinationTunnelHARAssembler();
const tunnel = await client.startTunnel({
  selectors: ['*.example.test'],
  inspection: {
    enabled: true,
    captureBodies: true,
    persist: true,
    ttlSeconds: 72 * 60 * 60,
  },
  onInspectionEvent: (event) => {
    const entry = assembler.add(event);
    if (entry) {
      console.log(`${entry.request.method} ${entry.request.url} -> ${entry.response.status}`);
    }
  },
});
console.log(`Destination tunnel ${tunnel.tunnelId} is capturing network traffic`);
console.log('Press Ctrl+C to stop or it will automatically close in 30 seconds');

process.on('SIGINT', () => {
  console.log('Closing the destination tunnel');
  tunnel.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Closing the destination tunnel');
  tunnel.close();
  process.exit(0);
});

await new Promise((resolve) => setTimeout(resolve, 30_000));
console.log('Closing the destination tunnel');
tunnel.close();
await limrun.androidInstances.delete(androidInstance.metadata.id);
console.log('Deleted instance');
