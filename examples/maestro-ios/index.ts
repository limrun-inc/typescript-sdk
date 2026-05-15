import path from 'node:path';
import { createRequire } from 'node:module';
import { Limrun } from '@limrun/api';

const require = createRequire(import.meta.url);
const { runMaestroIos } = require('@limrun/maestro-ios') as typeof import('@limrun/maestro-ios');

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const apiKey = process.env['LIM_API_KEY'];
  if (!apiKey) {
    throw new Error('Missing required environment variable LIM_API_KEY.');
  }

  const limrun = new Limrun({
    apiKey,
    ...(process.env['LIMRUN_BASE_URL'] ? { baseURL: process.env['LIMRUN_BASE_URL'] } : {}),
  });

  console.time('create');
  const instance = await limrun.iosInstances.create({
    wait: true,
    metadata: {
      labels: {
        name: 'maestro-ios-example',
      },
    },
  });
  console.timeEnd('create');

  try {
    // Lifecycle stays in the example; @limrun/maestro-ios only needs an existing target.
    if (!instance.status.apiUrl) {
      throw new Error('API URL is missing');
    }
    if (!instance.status.token) {
      throw new Error('Instance token is missing');
    }

    console.log(`Limrun stream: ${instance.status.signedStreamUrl}`);

    await runMaestroIos({
      apiUrl: instance.status.apiUrl,
      artifactsDir: path.resolve('artifacts/limrun-maestro'),
      flowPath: path.resolve('flows/hacker-news.yaml'),
      token: instance.status.token,
    });
  } finally {
    await limrun.iosInstances.delete(instance.metadata.id);
    console.log(`Deleted instance: ${instance.metadata.id}`);
  }
}
