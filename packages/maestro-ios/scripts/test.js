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

const runSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'run.ts'), 'utf8');
assert.ok(!runSource.includes('iosInstances.create'), 'package runner must not create Limrun instances');
assert.ok(!runSource.includes('iosInstances.delete'), 'package runner must not delete Limrun instances');

console.log('maestro-ios package checks passed');
