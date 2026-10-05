import { formatAppExit } from './format-app-exit';
import type { AppExitInfo } from '@limrun/api';

describe('formatAppExit', () => {
  it('formats a plain exit with logs', () => {
    const info: AppExitInfo = { packageName: 'com.example.app', reason: 'exit' };
    const out = formatAppExit(info.packageName, info, ['line one', 'line two']);
    expect(out).toContain('com.example.app exited (reason: exit)');
    expect(out).toContain('--- Recent app logs (2 lines) ---');
    expect(out).toContain('line one');
    expect(out.endsWith('line two')).toBe(true);
  });

  it('formats a crash with stack trace before the logs', () => {
    const info: AppExitInfo = {
      packageName: 'com.example.app',
      reason: 'crash',
      crash: {
        processName: 'com.example.app',
        pid: 4242,
        shortMsg: 'java.lang.RuntimeException',
        longMsg: 'java.lang.RuntimeException: boom',
        stackTrace: 'java.lang.RuntimeException: boom\n\tat MainActivity.onCreate\n',
        timeMillis: 1700000000000,
      },
    };
    const out = formatAppExit(info.packageName, info, ['log line']);
    expect(out).toContain('exited (reason: crash)');
    expect(out).toContain('Crash in com.example.app (pid 4242): java.lang.RuntimeException');
    expect(out).toContain('java.lang.RuntimeException: boom');
    expect(out).toContain('\tat MainActivity.onCreate');
    expect(out.indexOf('MainActivity')).toBeLessThan(out.indexOf('Recent app logs'));
  });

  it('formats an ANR with process stats', () => {
    const info: AppExitInfo = {
      packageName: 'com.example.app',
      reason: 'anr',
      anr: { processName: 'com.example.app', pid: 77, processStats: 'CPU usage: 99%\n' },
    };
    const out = formatAppExit(info.packageName, info, []);
    expect(out).toContain('exited (reason: anr)');
    expect(out).toContain('ANR in com.example.app (pid 77)');
    expect(out).toContain('CPU usage: 99%');
    expect(out).not.toContain('Recent app logs');
  });

  it('formats an iOS crash with its message', () => {
    const out = formatAppExit(
      'com.example.ios',
      {
        reason: 'crash',
        crash: {
          processName: 'App',
          pid: 9,
          shortMsg: 'EXC_BREAKPOINT (SIGTRAP)',
          longMsg: 'App/main.swift:60: Fatal error: boom',
          stackTrace: 'Thread Crashed:\n0   App  0x0000000100003aa0  Crasher.crash() + 128',
        },
      },
      [],
    );
    expect(out).toContain('com.example.ios exited (reason: crash)');
    expect(out).toContain('Crash in App (pid 9): EXC_BREAKPOINT (SIGTRAP)');
    expect(out).toContain('Fatal error: boom');
    expect(out).toContain('Crasher.crash() + 128');
  });

  it('omits the log section when no logs were delivered', () => {
    const info: AppExitInfo = { packageName: 'com.example.app', reason: 'terminated' };
    expect(formatAppExit(info.packageName, info, [])).toBe('com.example.app exited (reason: terminated)');
  });
});
