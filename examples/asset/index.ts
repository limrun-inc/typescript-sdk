import fs from 'fs';
import path from 'path';
import os from 'os';

import { Limrun, Ios } from '@limrun/api';

// Create a temporary directory for all operations
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-go-'));
// Download the Expo Go iOS Simulator build.
console.log('Downloading Expo Go iOS Simulator build...');
const expoGoPublicUrl =
  'https://github.com/expo/expo-go-releases/releases/download/Expo-Go-54.0.6/Expo-Go-54.0.6.tar.gz';
const expoGoLocalPath = path.join(tempDir, 'expo-go-54.0.6.tar.gz');
const response = await fetch(expoGoPublicUrl);
const buffer = await response.arrayBuffer();
fs.writeFileSync(expoGoLocalPath, Buffer.from(buffer));
console.log('Expo Go iOS Simulator build downloaded');

const apiKey = process.env['LIM_API_KEY'];

if (!apiKey) {
  console.error('Error: Missing required environment variables (LIM_API_KEY).');
  process.exit(1);
}

const limrun = new Limrun({ apiKey });

// Upload the zip file to Limrun Asset Storage.
console.log('Uploading Expo Go iOS Simulator build to Limrun Asset Storage...');
console.time('upload');
const asset = await limrun.assets.getOrUpload({ path: expoGoLocalPath });
console.log('Expo Go iOS Simulator build uploaded to Limrun Asset Storage');
console.timeEnd('upload');

// Create an iOS instance with that asset.
console.log('Creating an iOS Simulator instance...');
console.time('create');
const instance = await limrun.iosInstances.create({
  wait: true,
  reuseIfExists: true,
  metadata: {
    labels: {
      name: 'expo-go-ios-simulator-example',
    },
  },
  // spec: {
  //   initialAssets: [
  //     {
  //       kind: 'App',
  //       source: 'AssetName',
  //       assetName: asset.name,
  //     },
  //   ],
  // },
});
console.timeEnd('create');
console.log(`Instance ${instance.metadata.id} created.`);
if (!instance.status.apiUrl) {
  throw new Error('API URL is missing');
}
console.log(`Connecting to instance...`);
const ios = await Ios.createInstanceClient({
  apiUrl: instance.status.apiUrl,
  token: instance.status.token,
});
console.log(ios.deviceInfo, 'Installing Expo Go iOS Simulator build...');
console.time('install');
await ios.installApp(asset.signedDownloadUrl);
console.timeEnd('install');
ios.disconnect();
console.log('Expo Go iOS Simulator build installed');
console.log('Connect by clicking on the link below:');
console.log(`https://console.limrun.com/stream/${instance.metadata.id}`);

// Clean up temporary directory
fs.rmSync(tempDir, { recursive: true, force: true });
