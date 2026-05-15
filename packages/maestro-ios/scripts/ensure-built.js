'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const requiredOutputs = [
  path.join(root, 'dist', 'index.js'),
  path.join(root, 'dist', 'cli.js'),
  path.join(root, 'runner', 'build', 'libs', 'limrun-maestro-ios-runner.jar'),
];

if (requiredOutputs.every((output) => fs.existsSync(output))) {
  process.exit(0);
}

const result = spawnSync('npm', ['run', 'build'], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
