import { Ios, Limrun } from '@limrun/api';

const apiKey = process.env['LIM_API_KEY'];

if (!apiKey) {
  console.error('Error: Missing required environment variables (LIM_API_KEY).');
  process.exit(1);
}

const limrun = new Limrun({ apiKey });

console.time('create');
const instance = await limrun.iosInstances.create({
  wait: true,
  reuseIfExists: true,
  metadata: {
    labels: {
      name: 'ios-video-recording-example',
    },
  },
});
if (!instance.status.apiUrl) {
  throw new Error('API URL is missing');
}
const client = await Ios.createInstanceClient({
  apiUrl: instance.status.apiUrl,
  token: instance.status.token,
});
console.log('Connected to instance');
try {
  console.log('\n--- startRecording ---');
  await client.startRecording();
  console.log('Started recording');

  console.log('\n--- Testing launchApp ---');
  await client.launchApp('com.apple.mobilesafari');
  console.log('Launched Safari (default ForegroundIfRunning)');

  // Wait for app to launch
  await sleep(1000);
  console.log('\n--- Testing openUrl ---');
  await client.openUrl('https://apple.com');
  console.log('Opened URL: https://apple.com');

  // Wait for page to load
  await sleep(2000);

  await client.scroll('down', 500);
  console.log(`Scrolled down 100 pixels`);
  await sleep(1000);
  console.log('\n--- stopRecording ---');
  await client.stopRecording({ localPath: 'video.mp4' });
  console.log('Stopped recording and saved to video.mp4');
} catch (error) {
  console.error('Error:', error);
} finally {
  client.disconnect();
  console.log('\nDisconnected from instance');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
