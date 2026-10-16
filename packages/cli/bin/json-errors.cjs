// Keep parser and command errors machine-readable, including failures before flags are parsed.
function handleJsonError(error, argv = process.argv.slice(2)) {
  const delimiter = argv.indexOf('--');
  if (!argv.slice(0, delimiter < 0 ? argv.length : delimiter).includes('--json')) return false;
  const exitCode = error?.oclif?.exit ?? error?.exitCode ?? 1;
  process.exitCode = exitCode;
  // Explicit exits follow an already-emitted execution result, or a successful early exit.
  if (error?.code === 'EEXIT') return true;
  process.stderr.write(
    JSON.stringify({
      error: {
        code: typeof error?.code === 'string' ? error.code : 'CLI_ERROR',
        message: error instanceof Error ? error.message : String(error),
        ...(typeof error?.status === 'number' ? { status: error.status } : {}),
      },
    }) + '\n',
  );
  return true;
}

module.exports = { handleJsonError };
