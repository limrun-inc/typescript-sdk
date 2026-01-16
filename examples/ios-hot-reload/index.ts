import { Limrun, Ios } from '@limrun/api';

if (!process.env['SYNC_FOLDER_PATH']) {
  console.error('Error: Missing required environment variables (SYNC_FOLDER_PATH).');
  process.exit(1);
}

if (!process.env['LIM_API_KEY']) {
  console.error('Error: Missing required environment variables (LIM_API_KEY).');
  process.exit(1);
}

const lim = new Limrun({ apiKey: process.env['LIM_API_KEY'] });

const args = new Set(process.argv.slice(2));
const watch = args.has('--watch') || args.has('-w');

const instance = await lim.iosInstances.create({
  wait: true,
  reuseIfExists: true,
  metadata: {
    labels: {
      name: 'ios-hot-reload-example',
    },
  },
});
if (!instance.status.apiUrl) {
  throw new Error('API URL is missing');
}

const ios = await Ios.createInstanceClient({
  apiUrl: instance.status.apiUrl,
  token: instance.status.token,
});

console.log(`Setting up the sync for app folder at ${process.env['SYNC_FOLDER_PATH']}.`);
const result = await ios.syncApp(process.env['SYNC_FOLDER_PATH'], {
  install: true,
  watch,
});
if (watch) {
  console.log(`App folder is continuously syncing now. Press Ctrl+C to stop.`);
} else {
  console.log(`App folder synced once. Re-run with --watch to keep syncing on changes.`);
}
console.log(`You can access the instance at https://console.limrun.com/stream/${instance.metadata.id}`);
if (watch) {
  process.on('SIGINT', () => {
    result.stopWatching?.();
    ios.disconnect();
    process.exit(0);
  });
} else {
  ios.disconnect();
}
