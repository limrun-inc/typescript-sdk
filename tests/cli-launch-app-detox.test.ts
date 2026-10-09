import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveLocalDetoxVersion } from '../packages/cli/src/lib/detox-version';
import { buildLaunchAppArgument } from '../packages/cli/src/lib/launch-app-runtime';

describe('buildLaunchAppArgument', () => {
  test('keeps standard launch mode unchanged without runtime flags', () => {
    expect(buildLaunchAppArgument({}, { modeExplicitlyProvided: false })).toBe('ForegroundIfRunning');

    expect(
      buildLaunchAppArgument(
        {
          mode: 'ForegroundIfRunning',
        },
        { modeExplicitlyProvided: false },
      ),
    ).toBe('ForegroundIfRunning');
  });

  test('parses repeated env flags, empty values, equals signs and last value wins', () => {
    expect(
      buildLaunchAppArgument(
        { env: ['FEATURE=old', 'FEATURE=a=b c', 'EMPTY='] },
        { modeExplicitlyProvided: false },
      ),
    ).toEqual({
      mode: 'RelaunchIfRunning',
      env: { FEATURE: 'a=b c', EMPTY: '' },
    });
  });

  test.each([
    'MISSING',
    '=empty',
    'BAD-KEY=value',
    'KEY=bad\nvalue',
    'DYLD_LIBRARY_PATH=/tmp',
    'LIMRUN_INSERT_LIBRARIES=/tmp',
    'SIMCTL_CHILD_FEATURE=1',
  ])('rejects invalid --env %s', (entry) => {
    expect(() => buildLaunchAppArgument({ env: [entry] }, { modeExplicitlyProvided: false })).toThrow();
  });

  test('rejects env with explicit foreground and combines safe env with Detox', () => {
    expect(() =>
      buildLaunchAppArgument(
        { env: ['FEATURE=1'], mode: 'ForegroundIfRunning' },
        { modeExplicitlyProvided: true },
      ),
    ).toThrow('--env requires RelaunchIfRunning');
    expect(
      buildLaunchAppArgument(
        {
          env: ['FEATURE=1'],
          runtime: 'detox',
          'detox-server-url': 'ws://localhost:8099',
          'detox-session-id': 'session',
          'detox-version': '20.51.1',
        },
        { modeExplicitlyProvided: false },
      ),
    ).toMatchObject({ env: { FEATURE: '1' }, runtime: { kind: 'detox' } });
  });

  test('requires --runtime detox when detox flags are present', () => {
    expect(() =>
      buildLaunchAppArgument(
        {
          mode: 'ForegroundIfRunning',
          'detox-server-url': 'ws://10.244.0.10:57091',
          'detox-session-id': 'limrun-detox',
        },
        { modeExplicitlyProvided: false },
      ),
    ).toThrow('require --runtime detox');
  });

  test('requires server URL and session ID for detox runtime launches', () => {
    expect(() =>
      buildLaunchAppArgument(
        {
          mode: 'ForegroundIfRunning',
          runtime: 'detox',
          'detox-session-id': 'limrun-detox',
          'detox-version': '20.51.1',
        },
        { modeExplicitlyProvided: false },
      ),
    ).toThrow('--runtime detox requires --detox-server-url');

    expect(() =>
      buildLaunchAppArgument(
        {
          mode: 'ForegroundIfRunning',
          runtime: 'detox',
          'detox-server-url': 'ws://10.244.0.10:57091',
          'detox-version': '20.51.1',
        },
        { modeExplicitlyProvided: false },
      ),
    ).toThrow('--runtime detox requires --detox-session-id');
  });

  test('rejects explicitly foregrounded detox runtime launches', () => {
    expect(() =>
      buildLaunchAppArgument(
        {
          mode: 'ForegroundIfRunning',
          runtime: 'detox',
          'detox-server-url': 'ws://10.244.0.10:57091',
          'detox-session-id': 'limrun-detox',
          'detox-version': '20.51.1',
        },
        { modeExplicitlyProvided: true },
      ),
    ).toThrow('runtime launches require RelaunchIfRunning');
  });

  test('builds a detox runtime launch and treats defaulted foreground mode as omitted', () => {
    expect(
      buildLaunchAppArgument(
        {
          mode: 'ForegroundIfRunning',
          runtime: 'detox',
          'detox-server-url': 'ws://10.244.0.10:57091',
          'detox-session-id': 'limrun-detox',
          'detox-version': '20.51.1',
        },
        { modeExplicitlyProvided: false },
      ),
    ).toEqual({
      mode: 'RelaunchIfRunning',
      runtime: {
        kind: 'detox',
        serverUrl: 'ws://10.244.0.10:57091',
        sessionId: 'limrun-detox',
        version: '20.51.1',
      },
    });
  });

  test('resolves detox version from the provided cwd when omitted', () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'limrun-detox-runtime-'));
    try {
      const detoxDir = path.join(tmpdir, 'node_modules', 'detox');
      fs.mkdirSync(detoxDir, { recursive: true });
      fs.writeFileSync(path.join(detoxDir, 'package.json'), JSON.stringify({ version: '20.48.1' }));

      expect(
        buildLaunchAppArgument(
          {
            runtime: 'detox',
            'detox-server-url': 'ws://10.244.0.10:57091',
            'detox-session-id': 'limrun-detox',
          },
          { modeExplicitlyProvided: false, cwd: tmpdir },
        ),
      ).toEqual({
        mode: 'RelaunchIfRunning',
        runtime: {
          kind: 'detox',
          serverUrl: 'ws://10.244.0.10:57091',
          sessionId: 'limrun-detox',
          version: '20.48.1',
        },
      });
    } finally {
      fs.rmSync(tmpdir, { force: true, recursive: true });
    }
  });

  test('rejects non-websocket detox server URLs', () => {
    expect(() =>
      buildLaunchAppArgument(
        {
          mode: 'ForegroundIfRunning',
          runtime: 'detox',
          'detox-server-url': 'http://10.244.0.10:57091',
          'detox-session-id': 'limrun-detox',
          'detox-version': '20.51.1',
        },
        { modeExplicitlyProvided: false },
      ),
    ).toThrow('ws:// or wss://');
  });
});

describe('resolveLocalDetoxVersion', () => {
  let tmpdir: string;

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'limrun-detox-version-'));
  });

  afterEach(() => {
    fs.rmSync(tmpdir, { force: true, recursive: true });
  });

  test('reads the locally installed detox version', () => {
    const detoxDir = path.join(tmpdir, 'node_modules', 'detox');
    fs.mkdirSync(detoxDir, { recursive: true });
    fs.writeFileSync(path.join(detoxDir, 'package.json'), JSON.stringify({ version: '20.51.1' }));

    expect(resolveLocalDetoxVersion(tmpdir)).toBe('20.51.1');
  });

  test('fails clearly when detox is not installed locally', () => {
    expect(() => resolveLocalDetoxVersion(tmpdir)).toThrow('Missing --detox-version');
  });
});
