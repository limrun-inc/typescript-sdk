// Keep parser and command errors machine-readable, including failures before flags are parsed.
async function handleJsonError(error, argv = process.argv.slice(2)) {
  const delimiter = argv.indexOf('--');
  if (!argv.slice(0, delimiter < 0 ? argv.length : delimiter).includes('--json')) return false;
  const exitCode = error?.oclif?.exit ?? error?.exitCode ?? 1;
  process.exitCode = exitCode;
  // Explicit exits follow an already-emitted execution result, or a successful early exit.
  if (error?.code !== 'EEXIT') {
    process.stderr.write(
      JSON.stringify({
        error: {
          code: typeof error?.code === 'string' ? error.code : 'CLI_ERROR',
          message: error instanceof Error ? error.message : String(error),
          ...(typeof error?.status === 'number' ? { status: error.status } : {}),
        },
      }) + '\n',
    );
  }

  // SDK sockets can outlive a failed command. Flush both streams before forcing exit,
  // with the same ten-second flush budget as oclif for a stalled output consumer.
  const deadline = setTimeout(() => process.exit(exitCode), 10_000);
  deadline.unref();
  try {
    await Promise.all(
      [process.stdout, process.stderr].map((stream) => new Promise((resolve) => stream.write('', resolve))),
    );
  } finally {
    clearTimeout(deadline);
    process.exit(exitCode);
  }
  return true;
}

module.exports = { handleJsonError };
