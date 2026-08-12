import { gradleBuildOptionsFromFlags } from '../packages/cli/src/lib/gradle-build-options';

/**
 * Pins the flag-to-exec-options mapping that runs BEFORE instance resolution:
 * a contradictory flag combination must throw here (never after an instance
 * was auto-created), and reactNative must stay absent unless a flag asks for
 * it, because its mere presence opts the server into the Expo pipeline.
 */

test('no flags produce empty options with no reactNative key', () => {
  expect(gradleBuildOptionsFromFlags({})).toEqual({});
});

test('expo-app-dir alone opts in without architectures', () => {
  expect(gradleBuildOptionsFromFlags({ 'expo-app-dir': 'apps/mobile' })).toEqual({
    reactNative: { expoAppDir: 'apps/mobile' },
  });
});

test('repeated abi values are deduplicated', () => {
  expect(gradleBuildOptionsFromFlags({ abi: ['x86_64', 'x86_64', 'arm64-v8a'] })).toEqual({
    reactNative: { architectures: ['x86_64', 'arm64-v8a'] },
  });
});

test('abi all mixed with a specific ABI throws before any instance work', () => {
  expect(() => gradleBuildOptionsFromFlags({ abi: ['all', 'x86_64'] })).toThrow(
    'cannot be combined with specific ABIs',
  );
});

test('duplicated abi all is accepted as plain all', () => {
  expect(gradleBuildOptionsFromFlags({ abi: ['all', 'all'] })).toEqual({
    reactNative: { architectures: ['all'] },
  });
});

test('upload and signed-upload-url are mutually exclusive', () => {
  expect(() => gradleBuildOptionsFromFlags({ upload: 'a.apk', 'signed-upload-url': 'https://x' })).toThrow(
    'not both',
  );
});

test('upload-ttl requires a named upload', () => {
  expect(() => gradleBuildOptionsFromFlags({ 'upload-ttl': '24h' })).toThrow('requires --upload');
});

test('upload-name requires an upload destination', () => {
  expect(() => gradleBuildOptionsFromFlags({ 'upload-name': 'app-debug.apk' })).toThrow(
    'requires --upload',
  );
});

test('tasks, project path, artifact name, and upload TTL map through', () => {
  expect(
    gradleBuildOptionsFromFlags({
      task: ['assembleDebug'],
      'project-path': 'android',
      'upload-name': 'app-dev-debug.apk',
      upload: 'app.apk',
      'upload-ttl': '24h',
    }),
  ).toEqual({
    tasks: ['assembleDebug'],
    projectPath: 'android',
    artifactName: 'app-dev-debug.apk',
    upload: { assetName: 'app.apk', ttl: '24h' },
  });
});

// Play Store flag validation rides the same pre-instance contract as
// signing: contradictions throw here, never after an instance was billed.
// The service-account file read and playstore assembly live in the
// command, so the mapper only validates.

test('playstore flags without --upload-to-playstore throw', () => {
  expect(() => gradleBuildOptionsFromFlags({ 'playstore-track': 'internal' })).toThrow(
    'require --upload-to-playstore',
  );
});

test('an ambient Play access token does not poison a plain build', () => {
  expect(gradleBuildOptionsFromFlags({ 'playstore-access-token': 'token', task: ['assembleDebug'] })).toEqual(
    {
      tasks: ['assembleDebug'],
    },
  );
});

test('auto-version-code without --upload-to-playstore throws', () => {
  expect(() => gradleBuildOptionsFromFlags({ 'auto-version-code': true })).toThrow(
    'require --upload-to-playstore',
  );
});

test('an explicit auto-version-code false does not poison plain builds', () => {
  // Boolean flags carry truthiness semantics in the validator: off is
  // off, however it was spelled by a programmatic caller.
  expect(gradleBuildOptionsFromFlags({ 'auto-version-code': false, task: ['assembleDebug'] })).toEqual({
    tasks: ['assembleDebug'],
  });
});

test('upload-to-playstore without signing throws before any instance work', () => {
  expect(() =>
    gradleBuildOptionsFromFlags({
      'upload-to-playstore': true,
      'playstore-service-account': 'sa.json',
    }),
  ).toThrow('requires --sign or the --keystore flags');
});

test('upload-to-playstore without a Google credential throws', () => {
  expect(() => gradleBuildOptionsFromFlags({ sign: true, 'upload-to-playstore': true })).toThrow(
    'requires --playstore-service-account or --playstore-access-token',
  );
});

test('upload-to-playstore rejects multiple Google credentials', () => {
  expect(() =>
    gradleBuildOptionsFromFlags({
      sign: true,
      'upload-to-playstore': true,
      'playstore-service-account': 'sa.json',
      'playstore-access-token': 'token',
    }),
  ).toThrow('not both');
});

test('a short-lived access token is a valid Play credential', () => {
  expect(
    gradleBuildOptionsFromFlags({
      sign: true,
      upload: 'app.aab',
      'upload-to-playstore': true,
      'playstore-access-token': 'token',
      'playstore-track': 'internal',
    }),
  ).toEqual({ upload: { assetName: 'app.aab' } });
});

test('production track without an explicit release status throws', () => {
  expect(() =>
    gradleBuildOptionsFromFlags({
      sign: true,
      'upload-to-playstore': true,
      'playstore-service-account': 'sa.json',
      'playstore-track': 'production',
    }),
  ).toThrow('explicit --playstore-release-status');
});

test('upload-to-playstore with explicit non-bundle tasks throws', () => {
  expect(() =>
    gradleBuildOptionsFromFlags({
      sign: true,
      task: ['assembleRelease'],
      'upload-to-playstore': true,
      'playstore-service-account': 'sa.json',
    }),
  ).toThrow('include a bundle task');
});

test('a valid playstore combination passes validation without mapping playstore', () => {
  // The mapper stays pure: the command attaches options.playstore after
  // reading the service-account file.
  expect(
    gradleBuildOptionsFromFlags({
      sign: true,
      upload: 'app.aab',
      'upload-to-playstore': true,
      'playstore-service-account': 'sa.json',
      'playstore-track': 'internal',
    }),
  ).toEqual({ upload: { assetName: 'app.aab' } });
});
