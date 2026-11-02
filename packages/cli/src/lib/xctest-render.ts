import type { XctestCaseEvent, XctestSummaryEvent } from '@limrun/api';

/** One console line per finished case: verdict, identifier, duration, then the failure. */
export function formatCaseLine(event: XctestCaseEvent): string {
  const verdict = event.passed ? 'PASS' : 'FAIL';
  const base = `  ${verdict} ${event.testClass}/${event.method} (${event.durationMs}ms)`;
  if (event.passed || !event.failureMessage) {
    return base;
  }
  // Compiler-style file:line prefix, so terminals and CI log parsers link to the source.
  let location = '';
  if (event.failureFile) {
    location = event.failureLine ? `${event.failureFile}:${event.failureLine}: ` : `${event.failureFile}: `;
  }
  return `${base}\n       ${location}${event.failureMessage}`;
}

/** The run's closing line; a missing summary means the run died partway. */
export function formatSummaryLine(summary: XctestSummaryEvent | undefined): string {
  if (!summary) {
    return '  Test run ended without a summary; the run died partway.';
  }
  const counts = `${summary.passed} passed, ${summary.failed} failed`;
  if (summary.planFinished) {
    return `  ${counts}`;
  }
  return `  ${counts} (the test plan did not finish${summary.error ? `: ${summary.error}` : ''})`;
}
