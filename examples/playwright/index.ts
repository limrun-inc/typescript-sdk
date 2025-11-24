import { _android as android } from 'playwright';
import { Limrun } from '@limrun/api';

const apiKey = process.env['LIM_API_KEY'];

if (!apiKey) {
  console.error('Error: Missing required environment variables (LIM_API_KEY).');
  process.exit(1);
}

const limrun = new Limrun({ apiKey });

// Wait makes sure the request returns only after the URLs are set and
// the instance is ready to connect.
console.time('create');
const instance = await limrun.androidInstances.create({
  metadata: {
    labels: {
      name: 'playwright-example',
    },
  },
  spec: {
    initialAssets: [
      {
        kind: 'App',
        source: 'AssetName',
        assetName: 'SystemWebViewShell.apk',
      },
    ],
    sandbox: {
      playwrightAndroid: {
        enabled: true,
      },
    },
  },
  wait: true,
  reuseIfExists: true,
});
console.timeEnd('create');
console.log(`Instance created: ${instance.metadata.id}`);

if (!instance.status.sandbox?.playwrightAndroid?.url) {
  throw new Error('Playwright Android sandbox URL not found');
}

console.log(`Connecting to instance: ${instance.metadata.id}`);
console.time('connect');
const device = await android.connect(
  `${instance.status.sandbox.playwrightAndroid.url}?token=${instance.status.token}`,
);
console.timeEnd('connect');

console.log('Launching Chrome...');
const context = await device.launchBrowser({
  args: ['--disable-fre', '--no-default-browser-check', '--no-first-run'],
});
const page = await context.newPage();

console.log('Navigating to https://lim.run...');
await page.goto('https://lim.run');

console.log('Page title:', await page.title());

await context.close();
await device.close();
