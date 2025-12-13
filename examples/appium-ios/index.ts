import { Ios, Limrun } from '@limrun/api';
import { startTcpTunnel } from '@limrun/api/tunnel';
import { remote } from 'webdriverio';

const limrun = new Limrun({
  apiKey: 'lim_b1d6dbe3e3a0f143f316be7e125fc12bafc522e936860ecd',
  baseURL: 'https://api-staging.limrun.dev',
});

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
        url: 'https://github.com/appium/WebDriverAgent/releases/download/v10.4.2/WebDriverAgentRunner-Build-Sim-arm64.zip',
        launchMode: 'ForegroundIfRunning',
      },
    ],
    inactivityTimeout: '30m',
  },
});
console.timeEnd('create');
console.log(`Instance created: ${instance.metadata.id}`);
if (!instance.status.targetHttpPortUrlPrefix) {
  throw new Error('Target HTTP Port URL Prefix is missing');
}
if (!instance.status.apiUrl) {
  throw new Error('API URL is missing');
}
console.log(instance.status.apiUrl);
console.log(instance.status.token);
const wdaUrl =
  instance.status.targetHttpPortUrlPrefix
    .replace('limrun.dev', 'limrun.dev:443')
    .replace('limrun.net', 'limrun.net:443') + '8100';
console.log(`Will connect to WDA at ${wdaUrl}`);

// const client = await Ios.createInstanceClient({
//   apiUrl: instance.status.apiUrl,
//   token: instance.status.token,
// });

// const lsof = await client.lsof();
// console.log(lsof);
// const socket = lsof.find((s) => s.kind === 'unix' && s.path.includes('com.apple.webinspectord_sim.socket'));
// if (!socket) {
//   throw new Error('WebInspector socket not found');
// }
// const tunnel = await startTcpTunnel(
//   instance.status.apiUrl + '/port-forward?socketPath=' + socket.path,
//   instance.status.token,
//   '127.0.0.1',
//   9898,
//   {
//     mode: 'multiplexed',
//     logLevel: 'debug',
//   },
// );
// console.log(`Tunnel created: ${tunnel.address.address}:${tunnel.address.port}`);

// await new Promise((resolve) => setTimeout(resolve, 1_000_000));
// console.log('done');

const driver = await remote({
  capabilities: {
    platformName: 'iOS',
    'appium:app': 'com.apple.mobilesafari',
    'appium:automationName': 'XCUITest',
    // @ts-expect-error -- limInstance* are custom Appium vendor extensions
    'appium:limInstanceApiUrl': instance.status.apiUrl,
    'appium:limInstanceToken': instance.status.token,
    'appium:webDriverAgentUrl': wdaUrl,
    'appium:wdaLocalPort': 443,
    'appium:wdaRequestHeaders': {
      Authorization: `Bearer ${instance.status.token}`,
    },
    'appium:useNewWDA': false,
    'appium:usePreinstalledWDA': true,
    'appium:webviewConnectTimeout': 120_000,
    'appium:safariInitialUrl': 'https://news.ycombinator.com',
    'appium:includeSafariInWebviews': true,
  },
  hostname: '127.0.0.1',
  port: 4723,
  path: '/',
  protocol: 'http',
});
console.log('successfully connected to instance');

// Test: Go to Hacker News, scroll to bottom, click last link (requires Safari remote debugger)
await driver.url('https://news.ycombinator.com');
console.log('Navigated to Hacker News');

// Wait for page to load
await driver.pause(2000);

// Switch to webview context (requires remote debugger)
const contexts = await driver.getContexts();
console.log('Available contexts:', contexts);
const webviewContext = contexts.find((ctx) => String(ctx).includes('WEBVIEW'));
if (!webviewContext) {
  throw new Error('WEBVIEW context not found - remote debugger may not be working');
}
await driver.switchContext(webviewContext as string);
console.log('Switched to WEBVIEW context (remote debugger working!)');

// Scroll to bottom using JavaScript
await driver.execute('window.scrollTo(0, document.body.scrollHeight)');
console.log('Scrolled to bottom');

await driver.pause(1000);

// Find and click the "More" link at the bottom using CSS selector
const moreLink = await driver.$('a.morelink');
await moreLink.click();
console.log('Clicked the More link at the bottom');

await driver.pause(2000);
console.log('Test completed!');
