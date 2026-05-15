import path from 'path';

import { Ios, Limrun } from '@limrun/api';
import { prepareDetoxRun, runDetoxTest, type DetoxRunPrepareResult } from '@limrun/detox';

const apiKey = process.env['LIM_API_KEY'];
const expoUrl = process.env['EXPO_URL'];

if (!apiKey) {
  console.error('Error: Missing required environment variables (LIM_API_KEY).');
  process.exit(1);
}

if (!expoUrl) {
  console.error('Error: Missing required environment variables (EXPO_URL).');
  process.exit(1);
}

const limrun = new Limrun({ apiKey });
const sessionId = process.env['DETOX_SESSION_ID'] || 'limrun-detox-example';
const artifactDirectory = path.resolve(process.env['DETOX_ARTIFACTS_DIR'] || 'artifacts/limrun-detox');
const deleteAfterRun = process.env['LIMRUN_KEEP_INSTANCE'] !== 'true';
const screenshotNames = [
  'limrun-detox-home',
  'limrun-detox-counter',
  'limrun-detox-greeting',
  'limrun-detox-success',
];
const relativePath = (targetPath: string): string => {
  const relative = path.relative(process.cwd(), targetPath);
  return relative.startsWith('..') ? targetPath : relative || '.';
};

console.time('create');
const instance = await limrun.iosInstances.create({
  wait: true,
  reuseIfExists: false,
  metadata: {
    labels: {
      name: 'detox-ios-example',
    },
  },
  spec: {
    initialAssets: [
      {
        kind: 'App',
        source: 'AssetName',
        assetName: 'appstore/Expo-Go-54.0.6.tar.gz',
      },
    ],
  },
});
console.timeEnd('create');
if (instance.status.signedStreamUrl) {
  console.log('Limrun stream:', instance.status.signedStreamUrl);
}

if (!instance.status.apiUrl) {
  throw new Error('API URL is missing');
}
if (!instance.status.token) {
  throw new Error('Instance token is missing');
}

const client = await Ios.createInstanceClient({
  apiUrl: instance.status.apiUrl,
  token: instance.status.token,
});

let prepared: DetoxRunPrepareResult | undefined;
let completed = false;
try {
  console.log('Preparing Detox session...');
  prepared = await prepareDetoxRun({
    client,
    sessionId,
    artifactDirectory,
    version: process.env['DETOX_VERSION'],
  });
  console.log('Detox server:', prepared.detoxServerUrl);
  console.log('Remote Detox server:', prepared.remoteDetoxServerUrl);
  console.log('Detox runtime version:', prepared.version);

  console.log('Running Detox tests...');
  console.log('Starting the recording...');
  await client.startRecording();
  const result = await runDetoxTest({
    configPath: './.detoxrc.cjs',
    configuration: 'ios.limrun.expo-go',
    sessionId: prepared.sessionId,
    serverUrl: prepared.detoxServerUrl,
    iosId: instance.metadata.id,
    iosApiUrl: instance.status.apiUrl,
    iosToken: instance.status.token,
    artifactDirectory: prepared.artifactDirectory,
    cwd: process.cwd(),
    extraEnv: {
      EXPO_URL: expoUrl,
      LIMRUN_DETOX_SERVER_URL: prepared.remoteDetoxServerUrl,
      DETOX_VERSION: prepared.version,
    },
  });
  console.log('Stopping the recording...');
  await client.stopRecording({ localPath: 'detox-video.mp4' });
  console.log('Recording saved to detox-video.mp4');
  if (result.code !== 0) {
    throw new Error(`Detox test failed with exit code ${result.code}`);
  }
  completed = true;
} finally {
  await prepared?.cleanup();
  client.disconnect();
  let cleanupStatus: string;
  if (deleteAfterRun) {
    await limrun.iosInstances.delete(instance.metadata.id);
    cleanupStatus = `Deleted instance: ${instance.metadata.id}`;
  } else {
    cleanupStatus = `Kept instance: ${instance.metadata.id}`;
  }

  if (completed) {
    const resolvedArtifactDirectory = prepared?.artifactDirectory || artifactDirectory;
    const artifactPath = relativePath(resolvedArtifactDirectory);
    const screenshotPath = relativePath(path.join(resolvedArtifactDirectory, 'detox-artifacts'));
    console.log('\nLimrun Detox demo complete');
    console.log('Artifacts:', artifactPath);
    console.log(`Screenshots: ${screenshotPath} (${screenshotNames.length} files)`);
    console.log('Logs:', `${artifactPath}/{detox.stdout.log,detox.stderr.log,detox.summary.json}`);
    console.log(cleanupStatus);
  } else {
    console.log(cleanupStatus);
  }
}
