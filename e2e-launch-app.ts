/**
 * End-to-end test for Android launchApp/terminateApp + appExit callbacks
 * against a locally running limdroid container (started via limdroid15/run.sh).
 *
 * Usage: npx ts-node e2e-launch-app.ts
 */
import { execSync } from 'node:child_process';
import { createInstanceClient, type AppExitInfo } from './src/instance-client';

const PKG = 'com.android.settings';
const API_URL = 'http://127.0.0.1:8834';

function dockerExec(cmd: string): string {
  return execSync(`docker exec lim sh -c ${JSON.stringify(cmd)}`, { encoding: 'utf8' });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(
  register: (resolve: (v: { logs: string[]; info: AppExitInfo }) => void) => Promise<unknown>,
  timeoutMs = 60_000,
) {
  return new Promise<{ logs: string[]; info: AppExitInfo }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for appExit')), timeoutMs);
    register((v) => {
      clearTimeout(timer);
      resolve(v);
    }).catch((err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function main() {
  console.log('Connecting to', API_URL);
  const client = await createInstanceClient({ apiUrl: API_URL, token: 'e2e', logLevel: 'warn' });
  let failures = 0;

  const check = (name: string, cond: boolean, detail?: string) => {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ` (${detail})` : ''}`);
    if (!cond) failures++;
  };

  // ---- Scenario 1: crash ----
  console.log('\n[1] launchApp + real crash (cmd activity crash)');
  const crashResult = await waitForExit(async (resolve) => {
    const launched = await client.launchApp(PKG, {
      mode: 'RelaunchIfRunning',
      onExit: (logs, info) => resolve({ logs, info }),
    });
    console.log('  launched:', JSON.stringify(launched));
    await sleep(4000); // let the app settle
    console.log('  triggering crash via AMS');
    dockerExec(`cmd activity crash ${PKG}`);
  });
  check('reason is crash', crashResult.info.reason === 'crash', `reason=${crashResult.info.reason}`);
  check('crash info present', !!crashResult.info.crash);
  check(
    'stack trace mentions requested crash',
    (crashResult.info.crash?.stackTrace ?? '').includes('shell-induced crash') ||
      (crashResult.info.crash?.stackTrace ?? '').includes('Crash requested'),
  );
  check('logs delivered', crashResult.logs.length > 0, `${crashResult.logs.length} lines`);
  console.log('  crash.shortMsg:', crashResult.info.crash?.shortMsg);
  console.log('  crash.stackTrace (first 3 lines):');
  for (const line of (crashResult.info.crash?.stackTrace ?? '').split('\n').slice(0, 3)) {
    console.log('   |', line);
  }
  console.log('  last log line:', crashResult.logs[crashResult.logs.length - 1]);

  // ---- Scenario 2: terminateApp ----
  console.log('\n[2] launchApp + terminateApp');
  const termResult = await waitForExit(async (resolve) => {
    await client.launchApp(PKG, {
      mode: 'RelaunchIfRunning',
      onExit: (logs, info) => resolve({ logs, info }),
    });
    await sleep(4000);
    console.log('  calling terminateApp');
    await client.terminateApp(PKG);
  });
  check('reason is terminated', termResult.info.reason === 'terminated', `reason=${termResult.info.reason}`);
  check('no crash info', !termResult.info.crash);

  // ---- Scenario 3: external force-stop => plain exit ----
  console.log('\n[3] launchApp + external force-stop');
  const exitResult = await waitForExit(async (resolve) => {
    await client.launchApp(PKG, {
      mode: 'RelaunchIfRunning',
      onExit: (logs, info) => resolve({ logs, info }),
    });
    await sleep(4000);
    console.log('  force-stopping externally (adb-style)');
    dockerExec(`am force-stop ${PKG}`);
  });
  check('reason is exit', exitResult.info.reason === 'exit', `reason=${exitResult.info.reason}`);

  // ---- Scenario 5 (run before 4 for flow): watchApp + deeplink, no client launch ----
  console.log('\n[5] watchApp (no launch) + deeplink open + crash');
  const CHROME = 'com.android.chrome';
  dockerExec(`am force-stop ${CHROME}`); // ensure not running before the watch
  await sleep(1000);
  const deeplinkResult = await waitForExit(async (resolve) => {
    const watch = await client.watchApp(CHROME, (logs, info) => resolve({ logs, info }));
    console.log('  watch registered:', watch.execId);
    await client.openUrl('https://example.com');
    console.log('  deeplink opened, waiting for Chrome to settle');
    await sleep(8000); // let Chrome start and the watch adopt its processes
    console.log('  triggering crash via AMS');
    dockerExec(`cmd activity crash ${CHROME}`);
  }, 90_000);
  check('reason is crash', deeplinkResult.info.reason === 'crash', `reason=${deeplinkResult.info.reason}`);
  check('crash stack trace present', (deeplinkResult.info.crash?.stackTrace ?? '').length > 0);
  check('logs delivered', deeplinkResult.logs.length > 0, `${deeplinkResult.logs.length} lines`);
  console.log('  crash.processName:', deeplinkResult.info.crash?.processName);

  // ---- Scenario 6: watchApp for an already-running app, plain exit ----
  console.log('\n[6] watchApp on already-running app + external force-stop');
  dockerExec(
    `am start -n ${CHROME}/com.google.android.apps.chrome.Main >/dev/null 2>&1 || monkey -p ${CHROME} 1 >/dev/null 2>&1`,
  );
  await sleep(5000);
  const watchExitResult = await waitForExit(async (resolve) => {
    await client.watchApp(CHROME, (logs, info) => resolve({ logs, info }));
    await sleep(1000);
    console.log('  force-stopping externally');
    dockerExec(`am force-stop ${CHROME}`);
  });
  check('reason is exit', watchExitResult.info.reason === 'exit', `reason=${watchExitResult.info.reason}`);

  // ---- Scenario 4: launch failure for unknown package ----
  console.log('\n[4] launchApp of a non-installed package rejects');
  let rejected = false;
  try {
    await client.launchApp('com.does.not.exist', { onExit: () => {} });
  } catch (err) {
    rejected = true;
    console.log('  rejected with:', (err as Error).message);
  }
  check('launch rejected', rejected);

  client.disconnect();
  console.log(failures === 0 ? '\nALL SCENARIOS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('E2E failed:', err);
  process.exit(1);
});
