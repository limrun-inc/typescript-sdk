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

test('tasks, project path, and upload map through', () => {
  expect(
    gradleBuildOptionsFromFlags({
      task: ['assembleDebug'],
      'project-path': 'android',
      upload: 'app.apk',
    }),
  ).toEqual({
    tasks: ['assembleDebug'],
    projectPath: 'android',
    upload: { assetName: 'app.apk' },
  });
});
