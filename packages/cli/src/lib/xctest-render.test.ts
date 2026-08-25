import { formatCaseLine, formatSummaryLine } from './xctest-render';

test('a passing case renders one line without a message', () => {
  expect(
    formatCaseLine({
      type: 'case',
      testClass: 'AppTests.LoginTests',
      method: 'testValid',
      passed: true,
      durationMs: 312,
    }),
  ).toBe('  PASS AppTests.LoginTests/testValid (312ms)');
});

test('a failing case carries its first failure message indented', () => {
  expect(
    formatCaseLine({
      type: 'case',
      testClass: 'AppTests.LoginTests',
      method: 'testExpired',
      passed: false,
      durationMs: 95,
      failureMessage: 'XCTAssertEqual failed',
    }),
  ).toBe('  FAIL AppTests.LoginTests/testExpired (95ms)\n       XCTAssertEqual failed');
});

test('the summary line distinguishes finished, unfinished, and absent', () => {
  expect(formatSummaryLine({ type: 'summary', passed: 6, failed: 1, planFinished: true })).toBe(
    '  6 passed, 1 failed',
  );
  expect(
    formatSummaryLine({ type: 'summary', passed: 1, failed: 0, planFinished: false, error: 'host crashed' }),
  ).toBe('  1 passed, 0 failed (the test plan did not finish: host crashed)');
  expect(formatSummaryLine(undefined)).toBe('  Test run ended without a summary; the run died partway.');
});
