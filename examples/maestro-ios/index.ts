import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { Limrun, Ios } from '@limrun/api';
const execAsync = promisify(exec);

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
// on the simulator and WDA listens on port 8100 by default.
// The :443 addition is required by the Appium driver.
const runnerUrl = instance.status.targetHttpPortUrlPrefix + '8100';

// WDA may crash during the test and launchMode in initialAssets is effective only for
// the first installation. So, we make sure WDA is running before the test starts.
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

  await lim.simctl(['launch', '--terminate-running-process', 'booted', 'dev.mobile.maestro-driver-iosUITests.xctrunner']).wait();
  console.log('Runner launched');
}

const shimDir = await lim.startXcrunShim();
try {
  const command = [
    'maestro',
    'test',
    '--platform ios',
    '--device',
    lim.deviceInfo.udid,
    '--no-reinstall-driver',
    '--test-output-dir',
    'artifacts',
    'flows/expo-sample.yaml',
  ].join(' ');
  const { stdout, stderr } = await execAsync(command, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MAESTRO_EXPO_URL: expoUrl,
      PATH: `${shimDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
      USE_XCODE_TEST_RUNNER: '1',
    },
    maxBuffer: 10 * 1024 * 1024,
  });

  if (stdout) {
    process.stdout.write(stdout);
  }
  if (stderr) {
    process.stderr.write(stderr);
  }
} finally {
  await lim.disconnect();
}