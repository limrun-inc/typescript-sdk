#!/usr/bin/env node

const { flush } = require('@oclif/core');
const { Config } = require('@oclif/core/config');
const { handle } = require('@oclif/core/errors');
const { Help, standardizeIDFromArgv } = require('@oclif/core/help');
const { run } = require('@oclif/core/run');

function isUsageError(error) {
  return typeof error?.message === 'string' && error.message.includes('\nSee more help with --help');
}

async function inferCommandArgv(argv) {
  const config = await Config.load(__dirname);
  const normalizedArgv = standardizeIDFromArgv([...argv], config);
  const normalizedCommandId = normalizedArgv[0];

  if (normalizedCommandId && config.findCommand(normalizedCommandId)) {
    return { commandArgv: normalizedCommandId.split(':'), config };
  }

  const positionalPrefix = [];
  for (const token of argv) {
    if (token === '--' || token.startsWith('-')) break;
    positionalPrefix.push(token);
  }

  for (let i = positionalPrefix.length; i > 0; i -= 1) {
    const commandId = positionalPrefix.slice(0, i).join(':');
    if (config.findCommand(commandId)) {
      return { commandArgv: commandId.split(':'), config };
    }
  }

  return { commandArgv: undefined, config };
}

async function handleError(error) {
  if (!isUsageError(error)) {
    await handle(error);
    return;
  }

  error.message = error.message.replace(/\nSee more help with --help$/, '');

  const { commandArgv, config } = await inferCommandArgv(process.argv.slice(2));
  if (!commandArgv) {
    await handle(error);
    return;
  }

  console.error(typeof error.render === 'function' ? error.render() : error.message);
  console.error();

  const help = new Help(config, {
    ...(config.pjson.oclif.helpOptions ?? config.pjson.helpOptions),
    sendToStderr: true,
  });
  await help.showHelp(commandArgv);
  process.exitCode = error.oclif?.exit ?? 1;
}

run(process.argv.slice(2), __dirname).catch(handleError).finally(flush);
