import fs from 'node:fs';

import { Ios, Limrun } from '@limrun/api';

const argv = process.argv.slice(2);
const codeFolder = argv.find((arg, idx) => idx === 0 && !arg.startsWith('-'));
const bundleId = argFlag(argv, '--bundle-id');
const storekitPath = argFlag(argv, '--storekit');
const timeoutArg = argFlag(argv, '--timeout');
const timeoutSeconds = timeoutArg ? Number(timeoutArg) : 120;

if (!codeFolder || !bundleId) {
  console.error(
    'Usage: tsx index.ts <code-folder> --bundle-id <id> [--storekit <path>] [--timeout <seconds>]',
  );
  console.error('  <code-folder>        path to a folder containing the Xcode project');
  console.error('  --bundle-id <id>     bundle ID of the app (e.g. com.example.myapp)');
  console.error('  --storekit <path>    register this .storekit directly (skip discover)');
  console.error('  --timeout <seconds>  how long to wait for the paywall (default 120)');
  process.exit(1);
}

if (!process.env['LIM_API_KEY']) {
  console.error('Error: Missing required environment variables (LIM_API_KEY).');
  process.exit(1);
}

const lim = new Limrun({ apiKey: process.env['LIM_API_KEY'] });

console.log('Creating iOS instance with Xcode...');
const instance = await lim.iosInstances.create({
  wait: true,
  reuseIfExists: true,
  metadata: { labels: { name: 'ios-iap-testing-example' } },
  spec: { sandbox: { xcode: { enabled: true } } },
});
if (!instance.status.apiUrl) {
  throw new Error('API URL is missing from instance status');
}
const xcodeUrl = instance.status.sandbox?.xcode?.url;
if (!xcodeUrl) {
  throw new Error('Xcode URL is missing from instance status');
}
const streamUrl = `https://console.limrun.com/stream/${instance.metadata.id}`;
console.log(`Instance ready: ${streamUrl}`);

const xcode = await lim.xcodeInstances.createClient({
  apiUrl: xcodeUrl,
  token: instance.status.token,
});
const ios = await Ios.createInstanceClient({
  apiUrl: instance.status.apiUrl,
  token: instance.status.token,
});

console.log(`Syncing code from ${codeFolder}...`);
await xcode.sync(codeFolder, { watch: false });

console.log('Building with xcodebuild (ad-hoc signed server-side)...');
const build = xcode.xcodebuild();
build.stdout.on('data', (line) => process.stdout.write(line.toString()));
build.stderr.on('data', (line) => process.stderr.write(line.toString()));
const { exitCode } = await build;
if (exitCode !== 0) {
  throw new Error(`xcodebuild failed with exit code ${exitCode}`);
}
console.log(`Build succeeded. Installed: ${bundleId}`);

if (storekitPath) {
  // Explicit flow — user has a .storekit file on disk.
  console.log(`Registering StoreKit config from ${storekitPath}...`);
  const bytes = fs.readFileSync(storekitPath);
  await ios.setStoreKitConfig(bundleId, bytes);
  console.log(
    '\nOpen the paywall in the app — products should now come from the\n' +
      'local test environment (no Apple Account dialog, no sandbox).',
  );
} else {
  // Discover flow — server polls storekitd's cache while the user opens
  // the paywall. No .storekit file needed on disk; it's generated from
  // the amp-api response the app's first product fetch caches.
  console.log('\nNo --storekit supplied — running server-side discover.');
  console.log(`Open the paywall in the app at ${streamUrl}`);
  console.log(`Waiting up to ${timeoutSeconds}s for a StoreKit product fetch...`);
  const result = await ios.discoverStoreKitConfig(bundleId, { timeoutSeconds });
  console.log(
    `\nDiscovered ${result.itemsFound} items → ${result.productsCount} products + ` +
      `${result.subscriptionsCount} subscriptions across ${result.subscriptionGroupsCount} groups.`,
  );
  console.log(
    '\nReopen the paywall — products should now come from the local test\n' +
      'environment (no Apple Account dialog, no sandbox).',
  );
}

ios.disconnect();

function argFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0 || idx + 1 >= args.length) return undefined;
  const value = args[idx + 1];
  return value && !value.startsWith('-') ? value : undefined;
}
