import path from 'node:path';

import { Limrun } from '@limrun/api';
import { prepareMaestroRun, runMaestroTest } from '@limrun/maestro';

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const apiKey = process.env['LIM_API_KEY'];
  const expoUrl = process.env['EXPO_URL'];
  if (!apiKey) {
    throw new Error('Missing required environment variable LIM_API_KEY.');
  }
  if (!expoUrl) {
    throw new Error('Missing required environment variable EXPO_URL.');
  }

  const limrun = new Limrun({
    apiKey,
    ...(process.env['LIMRUN_BASE_URL'] ? { baseURL: process.env['LIMRUN_BASE_URL'] } : {}),
  });
  const keepInstance = process.env['LIMRUN_KEEP_INSTANCE'] === 'true';
  const artifactDirectory = path.resolve(process.env['MAESTRO_ARTIFACTS_DIR'] || 'artifacts/limrun-maestro');

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
      ],
    },
  });
  console.timeEnd('create');

  if (instance.status.signedStreamUrl) {
    console.log('Limrun stream:', instance.status.signedStreamUrl);
  }

  let prepared: Awaited<ReturnType<typeof prepareMaestroRun>> | undefined;
  let completed = false;
  try {
    prepared = await prepareMaestroRun({
      limrun,
      instance,
      ...(process.env['MAESTRO_BIN'] ? { maestroBin: process.env['MAESTRO_BIN'] } : {}),
      ...(process.env['MAESTRO_VERSION'] ? { maestroVersion: process.env['MAESTRO_VERSION'] } : {}),
    });

    const result = await runMaestroTest({
      prepared,
      flowPath: path.resolve('flows/expo-sample.yaml'),
      outputDir: artifactDirectory,
      env: {
        MAESTRO_EXPO_URL: expoUrl,
      },
      cwd: process.cwd(),
    });

    if (result.code !== 0) {
      throw new Error(`maestro exited with ${result.signal ? `signal ${result.signal}` : `code ${result.code}`}`);
    }

    completed = true;
  } finally {
    await prepared?.cleanup();
    if (keepInstance) {
      console.log(`Kept instance: ${instance.metadata.id}`);
    } else {
      await limrun.iosInstances.delete(instance.metadata.id);
      console.log(`Deleted instance: ${instance.metadata.id}`);
    }
  }

  if (completed) {
    console.log('\nLimrun Maestro demo complete');
    console.log('Artifacts:', artifactDirectory);
  }
}
