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
        source: 'URL',
        // Use Limrun asset storage in production to avoid being throttled by GitHub.
        url: 'https://github.com/appium/WebDriverAgent/releases/download/v10.4.2/WebDriverAgentRunner-Build-Sim-arm64.zip',
        launchMode: 'ForegroundIfRunning',
      },
    ],
  },
});
console.timeEnd('create');
if (!instance.status.targetHttpPortUrlPrefix) {
  throw new Error('Target HTTP Port URL Prefix is missing');
}
if (!instance.status.apiUrl) {
  throw new Error('API URL is missing');
}

// targetHttpPortUrlPrefix allows us to append any port to the URL to connect to that port
// on the simulator and WDA listens on port 8100 by default.
// The :443 addition is required by the Appium driver.
const wdaUrl = instance.status.targetHttpPortUrlPrefix.replace('limrun.net', 'limrun.net:443') + '8100';

// WDA may crash during the test and launchMode in initialAssets is effective only for
// the first installation. So, we make sure WDA is running before the test starts.
let wdaRunning = true;
try {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 3000);
  await fetch(wdaUrl + '/status', {
    headers: {
      Authorization: `Bearer ${instance.status.token}`,
    },
    signal: controller.signal,
  });
} catch (error) {
  wdaRunning = false;
}
if (!wdaRunning) {
  console.log('WDA is not running, launching it...');
  const lim = await Ios.createInstanceClient({
    apiUrl: instance.status.apiUrl,
    token: instance.status.token,
  });
  await lim.simctl(['launch', 'booted', 'com.facebook.WebDriverAgentRunner.xctrunner']).wait();
}

const driver = await remote({
  capabilities: {
    platformName: 'iOS',
    'appium:app': 'com.apple.mobilesafari',
    'appium:automationName': 'XCUITest',
    // @ts-expect-error -- limInstance* are our custom capabilities not known to webdriverio
    'appium:limInstanceApiUrl': instance.status.apiUrl,
    'appium:limInstanceToken': instance.status.token,
    'appium:webDriverAgentUrl': wdaUrl,
    'appium:wdaLocalPort': 443,
    'appium:wdaRequestHeaders': {
      Authorization: `Bearer ${instance.status.token}`,
    },
    'appium:useNewWDA': false,
    'appium:usePreinstalledWDA': true,
  },
  hostname: '127.0.0.1',
  port: 4723,
  path: '/',
  protocol: 'http',
});
console.log('Appium successfully connected to the Limrun iOS instance');

await driver.url('https://news.ycombinator.com');
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
