import { Limrun } from '@limrun/api';
import { startAdbTunnel } from '@limrun/api';

const apiKey = process.env['LIM_TOKEN'];

if (!apiKey) {
  console.error('Error: Missing required environment variables (LIM_TOKEN).');
  process.exit(1);
}

const limrun = new Limrun({ apiKey });

const androidInstance = await limrun.androidInstances.create({});

const { address, close } = await startAdbTunnel(androidInstance);

console.log(`ADB connected on ${address.address}:${address.port}`);
console.log('You can run `adb devices` to see the connected device');
console.log('Press Ctrl+C to exit or it will automatically close in 30 seconds');

process.on('SIGINT', () => {
  console.log('Closing the ADB tunnel');
  close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Closing the ADB tunnel');
  close();
  process.exit(0);
});

await new Promise((resolve) => setTimeout(resolve, 30_000));
console.log('Closing the ADB tunnel');
close();
