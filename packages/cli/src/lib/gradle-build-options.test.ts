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
    {
      name: 'empty-string keystore password is provided, not missing',
      flags: { ...byo, 'keystore-password': '' },
    },
    {
      name: 'ambient env passwords without --keystore do not poison a plain build',
      flags: { 'keystore-password': 'from-env', 'key-password': 'from-env' },
    },
    {
      name: 'ambient env passwords without --keystore do not poison --sign',
      flags: { sign: true, 'keystore-password': 'from-env', 'key-password': 'from-env' },
    },
    { name: 'sign and keystore together', flags: { sign: true, ...byo }, error: /not both/ },
    {
      name: 'keystore without the rest names the missing flags',
      flags: { keystore: 'upload.jks', 'key-alias': 'upload' },
      error: /--keystore-password, --key-password/,
    },
    { name: 'key-alias without keystore', flags: { 'key-alias': 'upload' }, error: /requires --keystore/ },
    { name: 'save-key without keystore', flags: { 'save-key': true }, error: /requires the --keystore/ },
    {
      name: 'application-id without sign or save-key',
      flags: { 'application-id': 'com.x' },
      error: /only applies to --sign or --save-key/,
    },
    {
      name: 'sign with an explicit non-bundle task',
      flags: { sign: true, task: ['assembleDebug'] },
      error: /include a bundle task/,
    },
    { name: 'sign with an explicit bundle task', flags: { sign: true, task: [':app:bundleRelease'] } },
    { name: 'BYO keystore with a debug task stays allowed', flags: { ...byo, task: ['assembleDebug'] } },
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
