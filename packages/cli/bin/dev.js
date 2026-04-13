#!/usr/bin/env node

// For development: registers ts-node so we can run from src/ directly
const path = require('path');
const project = path.join(__dirname, '..', 'tsconfig.json');

require('ts-node').register({ project });

const oclif = require('@oclif/core');

oclif.settings.debug = true;

oclif
  .execute({ development: true, dir: __dirname, args: process.argv.slice(2) })
  .then(oclif.flush)
  .catch(oclif.Errors.handle);
