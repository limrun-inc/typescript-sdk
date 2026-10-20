#!/usr/bin/env node

// For development: registers ts-node so we can run from src/ directly
const path = require('path');
const project = path.join(__dirname, '..', 'tsconfig.json');

// The build checks types; keep command startup independent of type-checking the source tree.
require('ts-node').register({ project, transpileOnly: true });

const oclif = require('@oclif/core');

oclif.settings.debug = true;
process.env.NODE_ENV = 'development';
const { handleJsonError } = require('./json-errors.cjs');

oclif
  .run(process.argv.slice(2), __dirname)
  .then(oclif.flush)
  .catch(async (error) => {
    if (!(await handleJsonError(error))) return oclif.Errors.handle(error);
  });
