import { spawn } from 'node:child_process';

import {
  Limrun,
  Ios,
  MAESTRO_RUNNER_BUNDLE_ID,
  MAESTRO_RUNNER_PORT,
  isMaestroRunnerRunning,
  maestroSpawnOptions,
  prepareMaestroRun,
  waitForMaestroRunner,
} from '@limrun/api';

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
let lim: Ios.InstanceClient | undefined;
try {
  if (!instance.status.apiUrl || !instance.status.targetHttpPortUrlPrefix) {
    throw new Error('Necessary URLs are missing');
  }
  lim = await Ios.createInstanceClient({
    apiUrl: instance.status.apiUrl,
    token: instance.status.token,
  });
  console.log('Device UDID:', lim.deviceInfo.udid);
  // targetHttpPortUrlPrefix allows us to append any port to the URL to connect to that port
  // on the simulator and the patched Maestro runner listens on MAESTRO_RUNNER_PORT.
  const runnerUrl = instance.status.targetHttpPortUrlPrefix + String(MAESTRO_RUNNER_PORT);

  // The runner may crash during the test and launchMode in initialAssets is effective only for
  // the first installation. So, we make sure the runner is running before the test starts.
  if (!(await isMaestroRunnerRunning(runnerUrl, instance.status.token))) {
    console.log('Runner is not running, launching it...');
    // The patched runner listens on MAESTRO_RUNNER_PORT by default, so launching it is enough.
    const launch = await lim
      .simctl(['launch', '--terminate-running-process', 'booted', MAESTRO_RUNNER_BUNDLE_ID])
      .wait();
    if (launch.code !== 0) {
      throw new Error(`Failed to launch the Maestro runner (exit code ${launch.code}): ${launch.stderr}`);
    }
    if (!(await waitForMaestroRunner(runnerUrl, instance.status.token))) {
      throw new Error('The Maestro runner did not become ready in time.');
    }
    console.log('Runner launched');
  }

  // Wires the local stock maestro CLI to the remote runner: xcrun shim on PATH
  // plus JVM proxy settings that route the driver's HTTP to the instance.
  const run = await prepareMaestroRun(lim, { runnerUrl });
  console.log(
    `Maestro ${run.maestroVersion}: driver port ${run.driverPort} -> remote runner port ${MAESTRO_RUNNER_PORT}`,
  );
  await lim.startRecording();
  console.log('Recording started');
  try {
    const proc = spawn(
      'maestro',
      ['test', ...run.args, '--test-output-dir', 'artifacts', 'flows/expo-sample.yaml'],
      {
        ...maestroSpawnOptions,
        cwd: process.cwd(),
        env: { ...process.env, ...run.env, MAESTRO_EXPO_URL: expoUrl },
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
  }
} finally {
  lim?.disconnect();
  await limrun.iosInstances.delete(instance.metadata.id);
  console.log('Instance deleted');
}
