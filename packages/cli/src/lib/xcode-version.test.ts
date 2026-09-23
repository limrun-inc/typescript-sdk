import type { XcodeInfo } from '@limrun/api';
import {
  formatXcode,
  formatXcodeVersion,
  parseXcodeVersion,
  preferenceSelects,
  resolveRequestedXcodeVersion,
  xcodeSelectorFor,
} from './xcode-version';
import { loadXcodeVersionPreference } from './config';

jest.mock('./config', () => ({ loadXcodeVersionPreference: jest.fn() }));
const config = { loadXcodeVersionPreference: loadXcodeVersionPreference as jest.Mock };

describe('parseXcodeVersion', () => {
  test.each(['27', '27.0', '27.1'])('accepts %j', (value) => {
    expect(parseXcodeVersion(value)).toBe(value);
  });
  test.each(['27.1.2', '27.', '.1', 'Xcode 27', '', '27a'])('rejects %j', (value) => {
    expect(() => parseXcodeVersion(value)).toThrow(
      '--xcode-version takes an Xcode major such as 27 or major.minor such as 27.1',
    );
  });
  test('names the caller in the error', () => {
    expect(() => parseXcodeVersion('27.0.1', 'version set')).toThrow(
      'version set takes an Xcode major such as 27 or major.minor such as 27.1',
    );
  });
});

describe('resolveRequestedXcodeVersion', () => {
  afterEach(() => config.loadXcodeVersionPreference.mockReset());

  test('the flag wins over the workspace preference and is not remembered', () => {
    config.loadXcodeVersionPreference.mockReturnValue('27');
    expect(resolveRequestedXcodeVersion('26')).toEqual({ version: '26', source: 'flag' });
  });
  test('falls back to the workspace preference', () => {
    config.loadXcodeVersionPreference.mockReturnValue('27.1');
    expect(resolveRequestedXcodeVersion(undefined)).toEqual({ version: '27.1', source: 'workspace' });
  });
  test('asks for nothing when neither is set, so the sandbox keeps its binding', () => {
    config.loadXcodeVersionPreference.mockReturnValue(null);
    expect(resolveRequestedXcodeVersion(undefined)).toBeUndefined();
  });
  test('rejects a malformed flag before any network call', () => {
    expect(() => resolveRequestedXcodeVersion('27.0.1')).toThrow('--xcode-version takes an Xcode major');
  });
});

const ga26 = { major: '26', version: '26.4', channel: 'ga' as const, developerDir: '/x/26.4' };
const ga27 = { major: '27', version: '27.0', channel: 'ga' as const, developerDir: '/x/27.0' };
const beta271 = { major: '27', version: '27.1', channel: 'beta' as const, developerDir: '/x/27.1' };
const ga271 = { major: '27', version: '27.1', channel: 'ga' as const, developerDir: '/x/27.1' };
const legacy27 = { major: '27', version: '27.0', developerDir: '/x/27.0' };
const fleet = [ga26, ga27, beta271];

describe('xcodeSelectorFor', () => {
  test('a GA is selected by its bare major, a beta by its version', () => {
    expect(xcodeSelectorFor(ga27, fleet)).toBe('27');
    expect(xcodeSelectorFor(beta271, fleet)).toBe('27.1');
  });
  test('with two GAs of one major only the newest answers to the bare major', () => {
    const twoGAs = [ga26, ga27, ga271];
    expect(xcodeSelectorFor(ga271, twoGAs)).toBe('27');
    expect(xcodeSelectorFor(ga27, twoGAs)).toBe('27.0');
  });
  test('a daemon without channels carries one Xcode per major, so the major selects it', () => {
    expect(xcodeSelectorFor(legacy27, [ga26, legacy27])).toBe('27');
  });
});

describe('preferenceSelects', () => {
  test('a bare major names the GA it would bind, never a beta', () => {
    expect(preferenceSelects('27', ga27, fleet)).toBe(true);
    expect(preferenceSelects('27', beta271, fleet)).toBe(false);
    expect(preferenceSelects('26', ga27, fleet)).toBe(false);
    expect(preferenceSelects('27', ga27, [ga26, ga27, ga271])).toBe(false);
  });
  test('a major.minor names that exact minor', () => {
    expect(preferenceSelects('27.1', beta271, fleet)).toBe(true);
    expect(preferenceSelects('27.1', ga27, fleet)).toBe(false);
    expect(preferenceSelects('27.0', ga27, fleet)).toBe(true);
    expect(preferenceSelects('26.4', { ...ga26, version: '26.4.1' }, fleet)).toBe(true);
  });
  test('on a daemon without channels a bare major matches its one Xcode of that major', () => {
    expect(preferenceSelects('27', legacy27, [ga26, legacy27])).toBe(true);
  });
});

describe('formatXcode', () => {
  test('prints version, build and the default marker', () => {
    expect(
      formatXcode({
        major: '26',
        version: '26.4',
        build: '17E192',
        versionKey: '26.4.0.17E192',
        developerDir: '/x',
        nodeDefault: true,
      }),
    ).toBe('26.4 (17E192) (node default)');
    expect(
      formatXcode({
        major: '27',
        version: '27.0',
        build: '27A5252f',
        versionKey: '27.0.0.27A5252f',
        developerDir: '/y',
        nodeDefault: false,
      }),
    ).toBe('27.0 (27A5252f)');
  });
  test('falls back to the version key, then to unknown', () => {
    expect(
      formatXcode({
        major: '',
        version: '',
        build: '',
        versionKey: '26.4.0.17E192',
        developerDir: '/x',
        nodeDefault: true,
      }),
    ).toBe('26.4.0.17E192');
    expect(formatXcode(undefined)).toBe('unknown (daemon predates Xcode selection)');
  });
});

describe('a malformed request fails before any sandbox work', () => {
  // build/test/rbe/create call resolveRequestedXcodeVersion right after parsing flags, so a
  // typo like 27.0 is rejected before a sandbox could be created and billed.
  test('resolveRequestedXcodeVersion throws synchronously for a bad flag', () => {
    expect(() => resolveRequestedXcodeVersion('twenty-seven')).toThrow();
  });
});

describe('formatXcodeVersion', () => {
  const x = (extra: Partial<XcodeInfo> = {}): XcodeInfo => ({
    major: '27',
    version: '27.0',
    build: '27A5252f',
    versionKey: '',
    developerDir: '',
    nodeDefault: false,
    ...extra,
  });

  test('names the beta seed between the version and the build', () => {
    expect(formatXcodeVersion(x({ betaSeed: '6' }))).toBe('27.0 beta 6 (27A5252f)');
    expect(formatXcodeVersion(x())).toBe('27.0 (27A5252f)');
  });

  test('formatXcode keeps the node-default mark after it', () => {
    expect(formatXcode(x({ major: '26', version: '26.4', build: '17E192', nodeDefault: true }))).toBe(
      '26.4 (17E192) (node default)',
    );
  });
});
