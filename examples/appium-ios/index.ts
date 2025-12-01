import { Limrun, Ios } from '@limrun/api';

const apiKey = process.env['LIM_API_KEY'];

if (!apiKey) {
  console.error('Error: Missing required environment variables (LIM_API_KEY).');
  process.exit(1);
}

const limrun = new Limrun({ apiKey });
console.time('create');
const instance = await limrun.iosInstances.create({ wait: true });
console.timeEnd('create');
if (!instance.status.endpointWebSocketUrl) {
  throw new Error('Endpoint WebSocket URL is missing');
}

console.log(`Instance ${instance.metadata.id} created`);

const client = await Ios.createInstanceClient({
  apiUrl: instance.status.endpointWebSocketUrl.replace('wss://', 'https://').replace('/signaling', ''),
  token: instance.status.token,
});

