import fs from 'fs';
import path from 'path';
import { Ios, Limrun } from '@limrun/api';

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
      name: 'websocket-ios-example',
    },
  },
});
if (!instance.status.apiUrl) {
  throw new Error('API URL is missing');
}
const client = await Ios.createInstanceClient({
  apiUrl: instance.status.apiUrl,
  token: instance.status.token,
  logLevel: 'debug',
});
console.log('Connected to instance');
try {
  // ========================================================================
  // Screenshot
  // ========================================================================
  console.log('\n--- Testing screenshot ---');
  const screenshot = await client.screenshot();
  console.log(
    `Screenshot taken: ${screenshot.width}x${screenshot.height}, ${screenshot.base64.length} bytes base64`,
  );
  // Save screenshot to file
  const screenshotPath = path.join(process.cwd(), 'screenshot.jpg');
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.base64, 'base64'));
  console.log(`Screenshot saved to: ${screenshotPath}`);

  // ========================================================================
  // Element Tree (Accessibility hierarchy)
  // ========================================================================
  console.log('\n--- Testing elementTree ---');
  const elementTree = await client.elementTree();
  console.log(`Element tree received: ${elementTree.length} characters`);
  // Parse and show summary
  const tree = JSON.parse(elementTree);
  console.log(`Root element type: ${tree.type || tree.AXRole || 'unknown'}`);

  // Element tree at specific point
  console.log('\n--- Testing elementTree at point ---');
  const pointTree = await client.elementTree({ x: 200, y: 400 });
  console.log(`Element tree at point: ${pointTree.length} characters`);

  // ========================================================================
  // List Apps
  // ========================================================================
  console.log('\n--- Testing listApps ---');
  const apps = await client.listApps();
  console.log(`Found ${apps.length} installed apps:`);
  apps.slice(0, 5).forEach((app) => {
    console.log(`  - ${app.name} (${app.bundleId}) [${app.installType}]`);
  });
  if (apps.length > 5) {
    console.log(`  ... and ${apps.length - 5} more`);
  }

  // ========================================================================
  // Launch App (Safari)
  // ========================================================================
  console.log('\n--- Testing launchApp ---');
  await client.launchApp('com.apple.mobilesafari');
  console.log('Launched Safari (default ForegroundIfRunning)');

  // Wait for app to launch
  await sleep(1000);

  // Relaunch Safari (terminates and relaunches even if already running)
  await client.launchApp('com.apple.mobilesafari', 'RelaunchIfRunning');
  console.log('Relaunched Safari (RelaunchIfRunning)');

  // ========================================================================
  // Terminate App
  // ========================================================================
  console.log('\n--- Testing terminateApp ---');
  await client.terminateApp('com.apple.mobilesafari');
  console.log('Terminated Safari');
  await sleep(10*1000);

  // Terminating again succeeds silently (app is already not running)
  await client.terminateApp('com.apple.mobilesafari');
  console.log('Terminated Safari again (no-op, already not running)');
  await sleep(1000)

  // Re-launch Safari for the rest of the example
  await client.launchApp('com.apple.mobilesafari');
  console.log('Re-launched Safari for remaining tests');
  await sleep(1000);

  // ========================================================================
  // Open URL
  // ========================================================================
  console.log('\n--- Testing openUrl ---');
  await client.openUrl('https://www.example.com');
  console.log('Opened URL: https://www.example.com');

  // Wait for page to load
  await sleep(2000);

  // ========================================================================
  // Tap at coordinates
  // ========================================================================
  console.log('\n--- Testing tap ---');
  // Tap in the center of the screen
  await client.tap(screenshot.width / 2, screenshot.height / 2);
  console.log(`Tapped at center: (${screenshot.width / 2}, ${screenshot.height / 2})`);

  await sleep(500);

  // ========================================================================
  // Tap Element by selector
  // ========================================================================
  console.log('\n--- Testing tapElement ---');
  try {
    // Try to tap the URL bar in Safari
    const result = await client.tapElement({ elementType: 'TextField' });
    console.log(`Tapped element: ${result.elementType} - "${result.elementLabel}"`);
  } catch (e) {
    console.log(`tapElement failed (expected if no matching element): ${(e as Error).message}`);
  }

  await sleep(500);

  // ========================================================================
  // Type Text
  // ========================================================================
  console.log('\n--- Testing typeText ---');
  await client.typeText('Hello from TypeScript SDK!');
  console.log('Typed text: "Hello from TypeScript SDK!"');

  await sleep(500);

  // ========================================================================
  // Toggle Software Keyboard
  // ========================================================================
  console.log('\n--- Testing toggleKeyboard ---');
  await client.toggleKeyboard();
  console.log('Toggled software keyboard');
  await sleep(500);

  // ========================================================================
  // Press Key
  // ========================================================================
  console.log('\n--- Testing pressKey ---');
  // Press Enter
  await client.pressKey('enter');
  console.log('Pressed Enter key');

  await sleep(500);

  // Press with modifiers (Command+A to select all)
  await client.pressKey('a', ['command']);
  console.log('Pressed Command+A');

  await sleep(500);

  // Press Escape
  await client.pressKey('escape');
  console.log('Pressed Escape key');

  await sleep(500);

  // ========================================================================
  // Set Element Value (faster than typing)
  // ========================================================================
  console.log('\n--- Testing setElementValue ---');
  try {
    // Try to set value on a text field
    const result = await client.setElementValue('https://apple.com', { elementType: 'TextField' });
    console.log(`Set value on element: "${result.elementLabel}"`);
  } catch (e) {
    console.log(`setElementValue failed (expected if no matching element): ${(e as Error).message}`);
  }

  // ========================================================================
  // Increment/Decrement Element (for sliders, steppers)
  // ========================================================================
  console.log('\n--- Testing incrementElement/decrementElement ---');
  try {
    // These will likely fail unless there's a slider/stepper on screen
    const incResult = await client.incrementElement({ elementType: 'Slider' });
    console.log(`Incremented element: "${incResult.elementLabel}"`);
  } catch (e) {
    console.log(`incrementElement failed (expected if no slider): ${(e as Error).message}`);
  }

  try {
    const decResult = await client.decrementElement({ elementType: 'Slider' });
    console.log(`Decremented element: "${decResult.elementLabel}"`);
  } catch (e) {
    console.log(`decrementElement failed (expected if no slider): ${(e as Error).message}`);
  }

  // ========================================================================
  // List Open Files (Unix sockets)
  // ========================================================================
  console.log('\n--- Testing lsof ---');
  const openFiles = await client.lsof();
  console.log(`Found ${openFiles.length} open unix sockets:`);
  openFiles.slice(0, 5).forEach((file) => {
    console.log(`  - [${file.kind}] ${file.path}`);
  });
  if (openFiles.length > 5) {
    console.log(`  ... and ${openFiles.length - 5} more`);
  }

  // ========================================================================
  // Simctl command (streaming)
  // ========================================================================
  console.log('\n--- Testing simctl ---');
  const execution = client.simctl(['listapps', 'booted']);

  execution.on('line-stdout', (line) => {
    console.log(`  stdout: ${line.substring(0, 100)}${line.length > 100 ? '...' : ''}`);
  });

  execution.on('line-stderr', (line) => {
    console.log(`  stderr: ${line}`);
  });

  const result = await execution.wait();
  console.log(`Simctl exited with code: ${result.code}`);

  // ========================================================================
  // Take final screenshot
  // ========================================================================
  console.log('\n--- Taking final screenshot ---');
  const finalScreenshot = await client.screenshot();
  const finalPath = path.join(process.cwd(), 'screenshot-final.jpg');
  fs.writeFileSync(finalPath, Buffer.from(finalScreenshot.base64, 'base64'));
  console.log(`Final screenshot saved to: ${finalPath}`);

  console.log('\n✅ All tests completed!');
} catch (error) {
  console.error('Error:', error);
} finally {
  client.disconnect();
  console.log('\nDisconnected from instance');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
