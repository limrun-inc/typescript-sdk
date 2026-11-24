import { Limrun, Ios } from '@limrun/api';
import { remote } from 'webdriverio';

const apiKey = process.env['LIM_API_KEY'];

if (!apiKey) {
  console.error('Error: Missing required environment variables (LIM_API_KEY).');
  process.exit(1);
}

const limrun = new Limrun({ apiKey });

console.time('create');
const instance = await limrun.iosInstances.create({
  wait: true,
  reuseIfExists: true,
  metadata: {
    labels: {
      name: 'appium-ios-example',
    },
  },
  spec: {
    initialAssets: [
      {
        kind: 'App',
        source: 'AssetName',
        // A simulator build of WebDriverAgent that Limrun hosts for every organization.
        assetName: 'appstore/WebDriverAgentRunner-16.15.3.zip',
        launchMode: 'ForegroundIfRunning',
      },
    ],
  },
});
console.timeEnd('create');
const { apiUrl, token } = instance.status;
if (!apiUrl || !token) {
  throw new Error('API URL or token is missing');
}
const lim = await Ios.createInstanceClient({
  apiUrl,
  token,
});
console.log('Device UDID:', lim.deviceInfo.udid);

// WDA may crash during the test and launchMode in initialAssets is effective only for
// the first installation. So, we make sure WDA is running before the test starts.
// WDA listens on port 8100, which the instance exposes over HTTPS.
let wdaRunning = true;
try {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 3000);
  await fetch(lim.targetHttpPortUrl(8100) + '/status', {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    signal: controller.signal,
  });
} catch (_) {
  wdaRunning = false;
}
if (!wdaRunning) {
  console.log('WDA is not running, launching it...');

  await lim.simctl(['launch', 'booted', 'com.facebook.WebDriverAgentRunner.xctrunner']).wait();
  console.log('WDA launched');
}
lim.disconnect();

const driver = await remote({
  capabilities: {
    platformName: 'iOS',
    browserName: 'safari',
    'appium:automationName': '@limrun/xcuitest',
    // The driver finds the simulator, its WebDriverAgent and the WDA credentials
    // from these two capabilities.
    // @ts-expect-error -- limInstance* are our custom capabilities not known to webdriverio
    'appium:limInstanceApiUrl': apiUrl,
    'appium:limInstanceToken': token,
    'appium:noReset': true, // Otherwise, deletes the app we installed.
    // Safari's first launch on a fresh instance can take a while to expose
    // its webviews to the remote debugger.
    'appium:webviewConnectTimeout': 60_000,
  },
  hostname: '127.0.0.1',
  port: 4723,
  path: '/',
  protocol: 'http',
});
console.log('Appium successfully connected to the Limrun iOS instance');
await driver.executeScript('window.location.assign(arguments[0])', ['https://news.ycombinator.com/']);
console.log('Navigated to Hacker News');

// Switch to webview context (requires remote debugger)
const contexts = await driver.getContexts();
console.log('Available contexts:', contexts);
const webviewContext = contexts.find((ctx) => String(ctx).includes('WEBVIEW'));
if (!webviewContext) {
  throw new Error('WEBVIEW context not found');
}
await driver.switchContext(webviewContext as string);
console.log('Switched to WEBVIEW context');
await driver.pause(1_000);

await driver.execute('window.scrollTo(0, document.body.scrollHeight)');
console.log('Scrolled to the bottom');

// Find and click the "More" link at the bottom using CSS selector
console.time('click.morelink');
await driver.$('a.morelink').click();
console.timeEnd('click.morelink');

console.time('getPageSource');
await driver.getPageSource();
console.timeEnd('getPageSource');
console.log('Done');

await driver.deleteSession();
