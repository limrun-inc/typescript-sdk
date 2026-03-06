import fs from 'fs';
import path from 'path';
import { createInstanceClient } from '@limrun/api';

// const apiKey = process.env['LIM_API_KEY'];

// if (!apiKey) {
//   console.error('Error: Missing required environment variables (LIM_API_KEY).');
//   process.exit(1);
// }

// const limrun = new Limrun({ apiKey });

// console.time('create');
// const instance = await limrun.androidInstances.create({
//   wait: true,
//   reuseIfExists: true,
//   metadata: {
//     labels: {
//       name: 'websocket-android-example',
//     },
//   },
// });
// console.timeEnd('create');

// if (!instance.status.endpointWebSocketUrl || !instance.status.adbWebSocketUrl) {
//   throw new Error('Missing endpointWebSocketUrl or adbWebSocketUrl on Android instance');
// }

const client = await createInstanceClient({
  endpointUrl: 'ws://127.0.0.1:8833/',
  adbUrl: '',
  token: '',
  logLevel: 'debug',
});

console.log('Connected to Android instance');

try {
  console.log('\n--- Testing screenshot ---');
  const screenshot = await client.screenshot();
  console.log(`Screenshot data URI length: ${screenshot.dataUri.length}`);
  const screenshotBase64 = screenshot.dataUri.replace(/^data:image\/\w+;base64,/, '');
  const screenshotPath = path.join(process.cwd(), 'android-screenshot.png');
  fs.writeFileSync(screenshotPath, Buffer.from(screenshotBase64, 'base64'));
  console.log(`Screenshot saved to: ${screenshotPath}`);

  console.log('\n--- Testing getElementTree ---');
  const tree = await client.getElementTree();
  console.log(`Element tree XML length: ${tree.xml.length}`);
  console.log(`Element tree nodes: ${tree.nodes.length}`);

  console.log('\n--- Testing findElement ---');
  const byText = await client.findElement({ text: 'Chrome' }, 5);
  console.log(`Found ${byText.count} element(s) with text "Chrome"`);

  console.log('\n--- Testing openUrl ---');
  await client.openUrl('https://www.example.com');
  console.log('Opened URL: https://www.example.com');
  await sleep(2000);

  console.log('\n--- Testing pressKey ---');
  await client.pressKey('BACK');
  console.log('Pressed BACK');
  await sleep(1000);

  console.log('\n--- Testing scrollScreen ---');
  await client.scrollScreen('down', 10);
  console.log('Scrolled screen down');
  await sleep(1000);

  console.log('\n--- Testing scrollScreen ---');
  await client.scrollScreen('up', 10);
  console.log('Scrolled screen up');
  await sleep(1000);

  console.log('\n--- Testing tapElement with selector ---');
  try {
    const tapResult = await client.tapElement({ selector: { clickable: true } });
    console.log(`Tapped element at (${tapResult.x}, ${tapResult.y})`);
  } catch (err) {
    console.log(`tapElement failed (expected in some UIs): ${(err as Error).message}`);
  }

  console.log('\n--- Testing setText ---');
  try {
    const setResult = await client.setText(
      {
        selector: {
          className: 'android.widget.EditText',
          enabled: true,
        },
      },
      'Hello from websocket-android example',
    );
    console.log(`Set text length: ${setResult.textLength}`);
  } catch (err) {
    console.log(`setText failed (expected if no EditText is available): ${(err as Error).message}`);
  }

  console.log('\n--- Taking final screenshot ---');
  const finalScreenshot = await client.screenshot();
  const finalBase64 = finalScreenshot.dataUri.replace(/^data:image\/\w+;base64,/, '');
  const finalPath = path.join(process.cwd(), 'android-screenshot-final.png');
  fs.writeFileSync(finalPath, Buffer.from(finalBase64, 'base64'));
  console.log(`Final screenshot saved to: ${finalPath}`);

  console.log('\nDone. websocket-android example completed.');
} catch (error) {
  console.error('Error:', error);
} finally {
  client.disconnect();
  console.log('\nDisconnected from Android instance');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
