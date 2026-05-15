'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const jarPath = path.resolve(__dirname, '..', 'runner', 'build', 'libs', 'limrun-maestro-ios-runner.jar');
assert.ok(fs.existsSync(jarPath), `runner jar is missing: ${jarPath}`);

const result = spawnSync('java', ['-jar', jarPath, '--version'], { encoding: 'utf8' });
if (result.error) {
  throw result.error;
}
assert.equal(result.status, 0, result.stderr || result.stdout);
assert.match(result.stdout, /Maestro 2\.5\.1/);
