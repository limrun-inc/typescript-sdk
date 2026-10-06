#!/usr/bin/env node

// Bazel's credential helper for the Limrun build plane. Bazel cannot pass
// arguments to a helper beyond `get`, so this executable maps its call onto
// `lim bazel credentials get`. Stdout must carry only the credentials JSON.
process.env.DOTENV_CONFIG_QUIET = 'true';

const { flush } = require('@oclif/core');
const { handle } = require('@oclif/core/errors');
const { run } = require('@oclif/core/run');

run(['bazel', 'credentials', ...process.argv.slice(2)], __dirname)
  .catch(handle)
  .finally(flush);
