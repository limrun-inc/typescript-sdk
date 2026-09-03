import { formatXcode, parseXcodeMajor, resolveRequestedXcodeVersion } from './xcode-version';

jest.mock('./config', () => ({ loadXcodeVersionPreference: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const config = require('./config') as { loadXcodeVersionPreference: jest.Mock };

describe('parseXcodeMajor', () => {
  test('accepts a bare major', () => {
    expect(parseXcodeMajor('27')).toBe('27');
  });
  test.each(['27.0', 'Xcode 27', '', '27a'])('rejects %j', (value) => {
    expect(() => parseXcodeMajor(value)).toThrow('--xcode-version takes an Xcode major such as 27');
  });
  test('names the caller in the error', () => {
    expect(() => parseXcodeMajor('27.0', 'version set')).toThrow(
      'version set takes an Xcode major such as 27',
    );
  });
});

describe('resolveRequestedXcodeVersion', () => {
  afterEach(() => config.loadXcodeVersionPreference.mockReset());

  test('the flag wins over the workspace preference and is not remembered', () => {
    config.loadXcodeVersionPreference.mockReturnValue('27');
    expect(resolveRequestedXcodeVersion('26')).toEqual({ major: '26', source: 'flag' });
  });
  test('falls back to the workspace preference', () => {
    config.loadXcodeVersionPreference.mockReturnValue('27');
    expect(resolveRequestedXcodeVersion(undefined)).toEqual({ major: '27', source: 'workspace' });
  });
  test('asks for nothing when neither is set, so the sandbox keeps its binding', () => {
    config.loadXcodeVersionPreference.mockReturnValue(null);
    expect(resolveRequestedXcodeVersion(undefined)).toBeUndefined();
  });
  test('rejects a malformed flag before any network call', () => {
    expect(() => resolveRequestedXcodeVersion('27.0')).toThrow('--xcode-version takes an Xcode major');
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
