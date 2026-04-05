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
  await client.startRecording();
  console.log('Started recording');

  await client.launchApp('com.apple.Preferences');
  console.log('Launched Settings');

  // Wait for Settings to render before tapping into General.
  await sleep(1000);
  await client.tapElement({ label: 'General' });
  console.log('Opened General in Settings');

  // Open Safari to apple.com from the simulator.
  await sleep(1000);
  await client.openUrl('https://apple.com');
  console.log('Opened URL: https://apple.com');

  // Wait for Safari and the page to load.
  await sleep(10*1000);
  await client.terminateApp('com.apple.mobilesafari');
  console.log('Terminated Safari');
  await sleep(1000);
  console.log('Stopping recording');
  console.time('stopRecording');
  await client.stopRecording({ localPath: 'video.mp4' });
  console.timeEnd('stopRecording');
  console.log('Stopped recording and saved to video.mp4');
} catch (error) {
  console.error('Error:', error);
} finally {
  client.disconnect();
  console.log('\nDisconnected from instance');
  await limrun.iosInstances.delete(instance.metadata.id);
  console.log('Deleted instance');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
