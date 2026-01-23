import { Limrun, Ios } from '@limrun/api';

const args = new Set(process.argv.slice(2));
const folderArg = process.argv.find((arg, idx) => idx > 1 && !arg.startsWith('-'));

const appPath = folderArg;
if (!appPath) {
  console.error('Error: Missing required folder path. Pass as first argument.');
  process.exit(1);
}

const watch = args.has('--watch') || args.has('-w');

if (!process.env['LIM_API_KEY']) {
  console.error('Error: Missing required environment variables (LIM_API_KEY).');
  process.exit(1);
}

const lim = new Limrun({ apiKey: process.env['LIM_API_KEY'] });

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
console.log(`You can access the instance at https://console.limrun.com/stream/${instance.metadata.id}`);

const ios = await Ios.createInstanceClient({
  apiUrl: instance.status.apiUrl,
  token: instance.status.token,
});

console.log(`Setting up the sync for app folder at ${appPath}.`);
const result = await ios.syncApp(appPath, { watch, launchMode: 'RelaunchIfRunning' });
if (watch) {
  console.log(`App folder is continuously syncing now. Press Ctrl+C to stop.`);
} else {
  console.log(`App folder synced once. Re-run with --watch to keep syncing on changes.`);
}
if (!result.installedBundleId) {
  throw new Error('Installed bundle ID is missing');
}
console.log(`Installed bundle ID: ${result.installedBundleId}`);
const bundleId = result.installedBundleId;

await new Promise<void>((resolve) => {
  console.log('Streaming app logs for 30 seconds...');
  const logStream = ios.streamAppLog(bundleId);
  logStream.on('line', (line) => {
    console.log(`[app-log] ${line}`);
  });
  logStream.on('error', (error) => {
    console.error('Failed to fetch app logs:', error);
  });
  setTimeout(() => {
    logStream.stop();
    console.log('Stopped app log streaming after 30 seconds.');
    resolve();
  }, 30000);
});

await new Promise<void>((resolve) => {
  console.log("Streaming syslog that contains your app's bundle ID for 30 seconds...");
  const syslog = ios.streamSyslog();
  syslog.on('line', (line) => {
    if (!line.includes(bundleId)) {
      return;
    }
    console.log(`[syslog] ${line}`);
  });
  syslog.on('error', (error) => {
    console.error('Failed to fetch syslog:', error);
  });
  setTimeout(() => {
    syslog.stop();
    console.log('Stopped syslog streaming after 30 seconds.');
    resolve();
  }, 30000);
});

console.log('Fetching last 10 lines of app logs...');
const appLogs = await ios.appLogTail(bundleId, 10);
console.log(appLogs);

if (watch) {
  console.log('Continuing to watch for changes...');
  process.on('SIGINT', () => {
    result.stopWatching?.();
    ios.disconnect();
    process.exit(0);
  });
} else {
  ios.disconnect();
}
