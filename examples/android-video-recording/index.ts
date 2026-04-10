import path from 'path';
import { Limrun, createInstanceClient } from '@limrun/api';

const apiKey = process.env['LIM_API_KEY'];

if (!apiKey) {
  console.error('Error: Missing required environment variables (LIM_API_KEY).');
  process.exit(1);
}

const limrun = new Limrun({ apiKey });

console.time('create');
const instance = await limrun.androidInstances.create({
  wait: true,
  reuseIfExists: true,
  metadata: {
    labels: {
      name: 'android-video-recording-example',
    },
  },
});
console.timeEnd('create');

if (!instance.status.apiUrl) {
  throw new Error('Missing endpointWebSocketUrl on Android instance');
}

const client = await createInstanceClient({
  apiUrl: instance.status.apiUrl,
  token: instance.status.token,
});

console.log('Connected to instance');

try {
  await client.startRecording();
  console.log('Started recording');

  await client.openUrl('https://www.android.com');
  console.log('Opened URL: https://www.android.com');

  await sleep(5000);
  await client.pressKey('HOME');
  console.log('Pressed HOME');

  await sleep(1000);
  await client.openUrl('https://www.example.com');
  console.log('Opened URL: https://www.example.com');

  await sleep(5000);
  console.log('Stopping recording');
  console.time('stopRecording');
  const localPath = path.join(process.cwd(), 'android-video.mp4');
  await client.stopRecording({ localPath });
  console.timeEnd('stopRecording');
  console.log(`Stopped recording and saved to ${localPath}`);
} catch (error) {
  console.error('Error:', error);
} finally {
  client.disconnect();
  console.log('\nDisconnected from instance');
  await limrun.androidInstances.delete(instance.metadata.id);
  console.log('Deleted instance');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
