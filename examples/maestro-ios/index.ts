import path from 'node:path';
import { spawn } from 'node:child_process';

import { Limrun, Ios } from '@limrun/api';

const MAESTRO_DRIVER_PORT = 7001;
const MAESTRO_RUNNER_PORT = 22087;

const apiKey = process.env['LIM_API_KEY'];
const expoUrl = process.env['EXPO_URL'];
if (!apiKey) {
  throw new Error('Missing required environment variable LIM_API_KEY.');
}
if (!expoUrl) {
  throw new Error('Missing required environment variable EXPO_URL.');
}

const limrun = new Limrun({ apiKey });

console.time('create');
const instance = await limrun.iosInstances.create({
  wait: true,
  reuseIfExists: true,
  metadata: {
    labels: {
      name: 'maestro-ios-example',
    },
  },
  spec: {
    initialAssets: [
      {
        kind: 'App',
        source: 'AssetName',
        assetName: 'appstore/Expo-Go-54.0.6.tar.gz',
      },
      {
        kind: 'App',
        source: 'AssetName',
        assetName: 'appstore/maestro-ios-runner-2.5.1.tar.gz',
      },
    ],
  },
});
console.timeEnd('create');
if (instance.status.signedStreamUrl) {
  console.log('Limrun stream:', instance.status.signedStreamUrl);
}
if (!instance.status.apiUrl || !instance.status.targetHttpPortUrlPrefix) {
  throw new Error('Necessary URLs are missing');
}
const lim = await Ios.createInstanceClient({
  apiUrl: instance.status.apiUrl,
  token: instance.status.token,
});
console.log('Device UDID:', lim.deviceInfo.udid);
// targetHttpPortUrlPrefix allows us to append any port to the URL to connect to that port
// on the simulator and the patched Maestro runner listens on MAESTRO_RUNNER_PORT.
const runnerUrl = instance.status.targetHttpPortUrlPrefix + String(MAESTRO_RUNNER_PORT);

// The runner may crash during the test and launchMode in initialAssets is effective only for
// the first installation. So, we make sure the runner is running before the test starts.
let wdaRunning = true;
try {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 3000);
  await fetch(runnerUrl + '/status', {
    headers: {
      Authorization: `Bearer ${instance.status.token}`,
    },
    signal: controller.signal,
  });
} catch (_) {
  wdaRunning = false;
}
if (!wdaRunning) {
  console.log('Runner is not running, launching it...');
  await lim.simctl(['spawn', 'booted', 'launchctl', 'setenv', 'PORT', String(MAESTRO_RUNNER_PORT)]).wait();
  await lim
    .simctl([
      'launch',
      '--terminate-running-process',
      'booted',
      'dev.mobile.maestro-driver-iosUITests.xctrunner',
    ])
    .wait();
  console.log('Runner launched');
}

const shimDir = await lim.startXcrunShim();
const proxyPort = await lim.startHttpProxy({
  remoteBaseUrl: instance.status.targetHttpPortUrlPrefix + String(MAESTRO_RUNNER_PORT),
  localPort: MAESTRO_DRIVER_PORT,
});
console.log(`Proxying local port ${proxyPort} to remote runner port ${MAESTRO_RUNNER_PORT}`);
await lim.startRecording();
console.log('Recording started');
try {
  const env = {
    ...process.env,
    MAESTRO_EXPO_URL: expoUrl,
    PATH: `${shimDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
    USE_XCODE_TEST_RUNNER: '1',
  };
  const proc = spawn(
    'maestro',
    [
      'test',
      '--platform',
      'ios',
      '--device',
      lim.deviceInfo.udid,
      '--no-reinstall-driver',
      '--test-output-dir',
      'artifacts',
      'flows/expo-sample.yaml',
    ],
    {
      cwd: process.cwd(),
      env,
      stdio: 'inherit',
    },
  );
  await new Promise<void>((resolve, reject) => {
    proc.once('error', reject);
    proc.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`maestro exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}`));
    });
  });
} finally {
  await lim.stopRecording({ localPath: 'video.mp4' });
  console.log('Recording stopped');
  lim.disconnect();
  limrun.iosInstances.delete(instance.metadata.id);
  console.log('Instance deleted');
}
