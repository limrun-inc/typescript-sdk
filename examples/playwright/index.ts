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
    sandbox: {
      playwrightAndroid: {
        enabled: true,
      },
    },
    clues: [
      {
        kind: 'OSVersion',
        osVersion: '15',
      },
    ],
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

// This is needed for Chrome's first-run initializations to complete.
await device.shell('am start com.android.chrome/com.google.android.apps.chrome.Main');
await new Promise((resolve) => setTimeout(resolve, 1_000));
await device.shell('am force-stop com.android.chrome');
console.log('Chrome is ready');

const browser = await device.launchBrowser();
console.log('Browser launched');

console.time('cdp.commands');
const page = await browser.newPage();
await page.goto('https://github.com/microsoft/playwright');
await page.waitForURL('https://github.com/microsoft/playwright');
console.log(await page.title());
console.log('Page title logged');
// Wait for main content to be visible
await page.waitForSelector('[data-hpc]', { state: 'visible' });
const linksCount = await page.locator('a').count();
console.log(`Links on page: ${linksCount}`);

console.time('click.github');
await page.locator('a[title=".github"]').first().click();
console.timeEnd('click.github');
await page.locator('a[title="workflows"]').first().click();
await page.locator('a[title="infra.yml"]').first().click();
// Scroll
await page.evaluate(() => {
  window.scrollTo(0, document.body.scrollHeight);
});
console.time('cdp.screenshot');
await page.screenshot({ path: 'screenshot.png' });
console.timeEnd('cdp.screenshot');
console.timeEnd('cdp.commands');

await device.close();
console.log('Session closed');

await limrun.androidInstances.delete(instance.metadata.id);
console.log('Instance deleted');
