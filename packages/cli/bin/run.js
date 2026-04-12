#!/usr/bin/env node

const oclif = require('@oclif/core');

oclif
  .execute({ dir: __dirname, args: process.argv.slice(2) })
  .then(oclif.flush)
  .catch(oclif.Errors.handle);
