'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, parseJavaMajorVersion, routeSupportMatrix } = require('../dist');

assert.equal(parseJavaMajorVersion('openjdk version "17.0.9" 2023-10-17'), 17);
assert.equal(parseJavaMajorVersion('java version "21.0.2" 2024-01-16 LTS'), 21);
assert.equal(parseJavaMajorVersion('openjdk version "26-ea" 2026-03-17'), 26);
assert.equal(parseJavaMajorVersion('java version "1.8.0_402"'), 8);
assert.equal(parseJavaMajorVersion('not a java version'), null);

const parsed = parseArgs(['test', '--test-output-dir', 'artifacts/out', 'flows/hacker-news.yaml']);
assert.equal(parsed.command, 'test');
assert.ok(parsed.flowPath.endsWith(path.join('flows', 'hacker-news.yaml')));
assert.ok(parsed.artifactsDir.endsWith(path.join('artifacts', 'out')));
assert.equal(parsed.timeoutMs, 10 * 60 * 1000);

const parsedEqualsFlag = parseArgs(['test', '--test-output-dir=artifacts/equal', 'flows/hacker-news.yaml']);
assert.ok(parsedEqualsFlag.artifactsDir.endsWith(path.join('artifacts', 'equal')));

const routes = new Set(routeSupportMatrix.map((item) => item.route));
assert.equal(routes.size, routeSupportMatrix.length, 'support matrix has duplicate routes');
for (const item of routeSupportMatrix) {
  assert.ok(item.notes, `missing support notes for ${item.route}`);
  assert.ok(['implemented', 'best-effort', 'unsupported'].includes(item.status), `invalid support status for ${item.route}`);
}

const kotlinPath = path.resolve(__dirname, '..', 'runner', 'src', 'main', 'kotlin', 'limrun', 'maestro', 'LimrunBridgeRunner.kt');
const kotlin = fs.readFileSync(kotlinPath, 'utf8');
const packageJson = require('../package.json');
assert.ok(kotlin.includes(`VERSION = "${packageJson.version}"`), 'Kotlin runner version must match package.json version');
assert.ok(kotlin.includes('MAESTRO_VERSION = "2.5.1"'), 'Kotlin runner Maestro version must stay explicit');
assert.ok(kotlin.includes('import maestro.utils.ScreenshotUtils'), 'Kotlin runner must use Maestro settle utilities');
assert.ok(kotlin.includes('SCREEN_SETTLE_TIMEOUT_MS = 3_000L'), 'Kotlin runner must keep Maestro iOS 3000ms first settle pass');
assert.ok(kotlin.includes('SCREENSHOT_DIFF_THRESHOLD = 0.005'), 'Kotlin runner must keep Maestro screenshot diff threshold');
assert.ok(kotlin.includes('ScreenshotUtils.waitUntilScreenIsStatic(timeoutMs, SCREENSHOT_DIFF_THRESHOLD, this)'), 'Kotlin runner must use Maestro screenshot static wait');
assert.ok(kotlin.includes('ScreenshotUtils.waitForAppToSettle(initialHierarchy, this, timeoutMs)'), 'Kotlin runner must use Maestro hierarchy settle fallback');
assert.ok(!kotlin.includes('post("waitUntilScreenIsStatic"'), 'Kotlin runner must not delegate screen-static waits to the TypeScript bridge');
assert.ok(!kotlin.includes('post("waitForAppToSettle"'), 'Kotlin runner must not delegate app-settle waits to the TypeScript bridge');
const gradleBuild = fs.readFileSync(path.resolve(__dirname, '..', 'runner', 'build.gradle.kts'), 'utf8');
assert.match(gradleBuild, /dev\.mobile:maestro-client:2\.5\.1/);
assert.match(gradleBuild, /dev\.mobile:maestro-orchestra:2\.5\.1/);
const postedRoutes = new Set([...kotlin.matchAll(/post\("([^"]+)"/g)].map((match) => match[1]));
for (const route of postedRoutes) {
  assert.ok(routes.has(route), `Kotlin driver route is missing from support matrix: ${route}`);
}

const bridgeSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'bridge.ts'), 'utf8');
const handledRoutes = new Set([...bridgeSource.matchAll(/case '([^']+)'/g)].map((match) => match[1]));
for (const item of routeSupportMatrix) {
  if (item.status !== 'unsupported') {
    assert.ok(handledRoutes.has(item.route), `supported route has no bridge handler: ${item.route}`);
  }
}
assert.ok(bridgeSource.includes('try {\n        resolve(body ? (JSON.parse(body) as JsonRecord) : {});'), 'bridge JSON parsing must reject parse errors');
assert.ok(!bridgeSource.includes('function sleep('), 'bridge must not keep unused user-controlled sleep helpers');
assert.ok(bridgeSource.includes("console.error('Bridge request failed:', error);"), 'bridge must log internal errors locally');
assert.ok(bridgeSource.includes("isUnsupportedRoute ? error.message : 'internal_error'"), 'bridge must not expose internal 500 error details');
assert.ok(bridgeSource.includes("case 'DOWN':\n      return 'up';"), 'Maestro swipe DOWN must map to Limrun scroll up');
assert.ok(bridgeSource.includes("case 'LEFT':\n      return 'right';"), 'Maestro swipe LEFT must map to Limrun scroll right');
assert.ok(bridgeSource.includes("case 'RIGHT':\n      return 'left';"), 'Maestro swipe RIGHT must map to Limrun scroll left');
assert.ok(bridgeSource.includes("default:\n      return 'down';"), 'Maestro swipe UP must map to Limrun scroll down');

const runSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'run.ts'), 'utf8');
assert.ok(!runSource.includes('iosInstances.create'), 'package runner must not create Limrun instances');
assert.ok(!runSource.includes('iosInstances.delete'), 'package runner must not delete Limrun instances');
assert.ok(runSource.includes('const closeLogStreams = () =>'), 'runner must centralize log stream cleanup');
assert.ok(runSource.includes('closeLogStreams();\n      reject(error);'), 'runner spawn errors must close log streams');
assert.ok(!runSource.includes('onChild'), 'runner must not keep unused child callback plumbing');

const buildRunnerSource = fs.readFileSync(path.resolve(__dirname, 'build-runner.js'), 'utf8');
assert.ok(buildRunnerSource.includes("response.on('error', reject);"), 'Gradle download must handle response stream errors');

console.log('maestro-ios package checks passed');
