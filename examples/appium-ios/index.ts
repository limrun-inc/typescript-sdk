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
        url: 'https://github.com/appium/WebDriverAgent/releases/download/v10.4.0/WebDriverAgentRunner-Build-Sim-arm64.zip',
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
console.log(instance.status.apiUrl);
const wdaUrl = new URL(instance.status.targetHttpPortUrlPrefix + '9100');
console.log(`Instance ${instance.metadata.id} created`);

const client = Ios.createInstanceClient({
  apiUrl: instance.status.apiUrl,
  token: instance.status.token,
});

const driver = await remote({
  capabilities: {
    platformName: 'iOS',
    'appium:app': 'com.apple.mobilesafari',
    'appium:automationName': 'XCUITest',
    // @ts-expect-error -- limInstance* are custom Appium vendor extensions
    'appium:limInstanceApiUrl': instance.status.apiUrl,
    'appium:limInstanceToken': instance.status.token,
    'appium:webDriverAgentUrl': wdaUrl.toString(),
  },
  hostname: '127.0.0.1',
  port: 4723,
  path: '/',
  protocol: 'http',
});
console.log('successfully connected to instance');
