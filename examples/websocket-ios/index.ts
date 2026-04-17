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
  console.log(`Element tree received: ${elementTree.length} root nodes`);
  const root = elementTree[0];
  console.log(`Root element type: ${root.type || 'unknown'}`);

  // Element tree at specific point
  console.log('\n--- Testing tapElement ---');
  const safari = await client.tapElement({ AXUniqueId: 'Safari' });
  console.log(`Tapped element: ${safari.elementType} - "${safari.elementLabel}"`);
  await sleep(3 * 1000);
  const urlBar = await client.tapElement({ type: 'TextField' });
  console.log(`Tapped element: ${urlBar.elementType} - "${urlBar.elementLabel}"`);
  await sleep(1 * 1000);

  // ========================================================================
  // Type Text
  // ========================================================================
  console.log('\n--- Testing typeText ---');
  await client.typeText('Hello from TypeScript SDK!');
  console.log('Typed text: "Hello from TypeScript SDK!"');

  // ========================================================================
  // Toggle Software Keyboard
  // ========================================================================
  console.log('\n--- Testing toggleKeyboard ---');
  await client.toggleKeyboard();
  console.log('Toggled software keyboard');
  await sleep(1000);
  await client.toggleKeyboard();
  console.log('Toggled software keyboard off');
  await sleep(1000);

  console.log('\n--- Testing pressKey ---');
  // Press Enter
  await client.pressKey('enter');
  console.log('Pressed Enter key');

  await sleep(3 * 1000);

  await client.tapElement({ type: 'Button', AXLabel: 'Close' });
  await sleep(5 * 1000);

  // ========================================================================
  // Set Element Value (faster than typing)
  // ========================================================================
  console.log('\n--- Testing setElementValue ---');
  try {
    await client.tapElement({ type: 'TextField' });
    await sleep(2 * 1000);
    // Try to set value on a text field
    const result = await client.setElementValue('https://apple.com', { type: 'TextField' });
    console.log(`Set value on element: "${result.elementLabel}"`);
    await client.pressKey('enter');
  } catch (e) {
    console.log(`setElementValue failed (expected if no matching element): ${(e as Error).message}`);
  }

  await sleep(3 * 1000);

  // ========================================================================
  // Simctl command (streaming)
  // ========================================================================
  console.log('\n--- Testing simctl ---');
  const execution = client.simctl(['listapps', 'booted']);

  let lineCount = 0;
  execution.on('line-stdout', (line) => {
    if (lineCount < 10) {
      console.log(`  stdout: ${line.substring(0, 100)}${line.length > 100 ? '...' : ''}`);
      lineCount++;
    }
  });

  execution.on('line-stderr', (line) => {
    if (lineCount < 10) {
      console.log(`  stderr: ${line}`);
      lineCount++;
    }
  });

  const result = await execution.wait();
  console.log(`Simctl exited with code: ${result.code}`);

  // ========================================================================
  // performActions (batch) - custom scroll gesture built from raw HID
  // primitives (touchDown / touchMove / touchUp).
  //
  // This bypasses the `scroll` helper so you can pick your own pacing,
  // distance and interpolation. We scroll the page down 200px and then
  // back up 200px at the center of the screen.
  // ========================================================================
  console.log('\n--- Testing performActions: HID scroll gestures ---');
  const cx = client.deviceInfo.screenWidth / 2;
  const startY = client.deviceInfo.screenHeight / 2 + 100;
  const endY = startY - 200;

  try {
    const hidResult = await client.performActions(
      [
        // Scroll content up by 200px (finger moves up, page scrolls up).
        { type: 'touchDown', x: cx, y: startY },
        { type: 'wait', durationMs: 30 },
        { type: 'touchMove', x: cx, y: startY - 50 },
        { type: 'wait', durationMs: 30 },
        { type: 'touchMove', x: cx, y: startY - 100 },
        { type: 'wait', durationMs: 30 },
        { type: 'touchMove', x: cx, y: startY - 150 },
        { type: 'wait', durationMs: 30 },
        { type: 'touchMove', x: cx, y: endY },
        { type: 'touchUp', x: cx, y: endY },
        { type: 'wait', durationMs: 800 },

        // Now scroll back in the opposite direction (finger moves down).
        { type: 'touchDown', x: cx, y: endY },
        { type: 'wait', durationMs: 30 },
        { type: 'touchMove', x: cx, y: endY + 50 },
        { type: 'wait', durationMs: 30 },
        { type: 'touchMove', x: cx, y: endY + 100 },
        { type: 'wait', durationMs: 30 },
        { type: 'touchMove', x: cx, y: endY + 150 },
        { type: 'wait', durationMs: 30 },
        { type: 'touchMove', x: cx, y: startY },
        { type: 'touchUp', x: cx, y: startY },
      ],
      // HID gesture is short (~1s of waits) — tight timeout to fail fast.
      { timeoutMs: 10_000 },
    );
    console.log(`performActions: ${hidResult.results.length} HID event(s) executed`);
    console.log('  HID scroll round-trip complete');
  } catch (e) {
    console.log(`HID batch stopped early: ${(e as Error).message}`);
  }

  const applePageTree = await client.elementTree();
  console.log(`Apple page tree received: ${applePageTree.length} root nodes`);
  for (const match of findNodesWithTrait(applePageTree, 'WebContent')) {
    console.log(
      `WebContent node: type=${match.type}, role=${match.role}, label="${match.AXLabel ?? ''}", id="${
        match.AXUniqueId ?? ''
      }"`,
    );
  }

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

function findNodesWithTrait(nodes: Ios.ElementTree, trait: string): Ios.ElementTreeNode[] {
  const matches: Ios.ElementTreeNode[] = [];

  const visit = (node: Ios.ElementTreeNode): void => {
    if (node.traits.includes(trait)) {
      matches.push(node);
    }

    for (const child of node.children ?? []) {
      visit(child);
    }
  };

  for (const node of nodes) {
    visit(node);
  }

  return matches;
}
