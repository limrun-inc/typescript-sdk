import { formatXcode, parseXcodeMajor } from './xcode-version';

describe('parseXcodeMajor', () => {
  test('accepts a bare major', () => {
    expect(parseXcodeMajor('27')).toBe('27');
  });
  test.each(['27.0', 'Xcode 27', '', '27a'])('rejects %j', (value) => {
    expect(() => parseXcodeMajor(value)).toThrow('--xcode-version takes an Xcode major such as 27');
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
