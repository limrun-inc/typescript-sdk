import { gradleBuildOptionsFromFlags, type GradleBuildFlagValues } from './gradle-build-options';

const byo = {
  keystore: 'upload.jks',
  'keystore-password': 'store-pass',
  'key-alias': 'upload',
  'key-password': 'key-pass',
};

describe('gradleBuildOptionsFromFlags signing validation', () => {
  const cases: Array<{ name: string; flags: GradleBuildFlagValues; error?: RegExp }> = [
    { name: 'no signing flags', flags: {} },
    { name: 'sign alone', flags: { sign: true } },
    { name: 'sign with application-id', flags: { sign: true, 'application-id': 'com.x' } },
    { name: 'full BYO group', flags: { ...byo } },
    { name: 'full BYO group with save-key', flags: { ...byo, 'save-key': true, 'application-id': 'com.x' } },
    { name: 'sign and keystore together', flags: { sign: true, ...byo }, error: /not both/ },
    {
      name: 'partial BYO group names the missing flags',
      flags: { keystore: 'upload.jks', 'key-alias': 'upload' },
      error: /--keystore-password, --key-password/,
    },
    { name: 'save-key without keystore', flags: { 'save-key': true }, error: /requires the --keystore/ },
    {
      name: 'application-id without sign or save-key',
      flags: { 'application-id': 'com.x' },
      error: /only applies to --sign or --save-key/,
    },
  ];

  it.each(cases)('$name', ({ flags, error }) => {
    if (error) {
      expect(() => gradleBuildOptionsFromFlags(flags)).toThrow(error);
    } else {
      expect(() => gradleBuildOptionsFromFlags(flags)).not.toThrow();
    }
  });

  it('never maps signing material itself: the command resolves it asynchronously', () => {
    expect(gradleBuildOptionsFromFlags({ ...byo }).signing).toBeUndefined();
    expect(gradleBuildOptionsFromFlags({ sign: true }).signing).toBeUndefined();
  });
});
