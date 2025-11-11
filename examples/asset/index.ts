import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import os from 'os';

import { Limrun } from '@limrun/api';

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

// Extract the tar.gz file
console.log('Extracting Expo Go tar.gz file...');
const expoAppPath = path.join(tempDir, 'Expo.app');
fs.mkdirSync(expoAppPath);
execSync(`tar -xzf ${expoGoLocalPath} -C ${expoAppPath}`);
console.log('Expo Go tar.gz file extracted');

// Create a zip file with the Expo.app folder
console.log('Creating zip file with Expo.app folder...');
const zipFilePath = path.join(tempDir, 'Expo.app.zip');

// Create the zip file using the zip command (available on macOS)
// -X excludes extra file attributes for reproducibility
execSync(`cd ${tempDir} && zip -rX ${zipFilePath} Expo.app`);
console.log('Zip file created:', zipFilePath);

const apiKey = process.env['LIM_API_KEY'];

if (!apiKey) {
  console.error('Error: Missing required environment variables (LIM_API_KEY).');
  process.exit(1);
}

const limrun = new Limrun({ apiKey });

// Upload the zip file to Limrun Asset Storage.
console.log('Uploading Expo.app.zip to Limrun Asset Storage...');
console.time('upload');
const asset = await limrun.assets.getOrUpload({ path: zipFilePath });
console.log('Expo.app.zip uploaded to Limrun Asset Storage');
console.timeEnd('upload');
// Create an iOS instance with that asset.
console.log('Creating iOS instance with Expo Go iOS Simulator build...');
console.time('create');
const instance = await limrun.iosInstances.create({
  wait: true,
  spec: {
    initialAssets: [
      {
        kind: 'App',
        source: 'AssetName',
        assetName: asset.name,
      },
    ],
  },
});
console.timeEnd('create');
console.log(`Instance ${instance.metadata.id} created.`);
console.log('Connect by clicking on the link below:');
console.log(`https://console.limrun.com/stream/${instance.metadata.id}`);

// Clean up temporary directory
fs.rmSync(tempDir, { recursive: true, force: true });
