import { Parser } from '@oclif/core';
import GradleBuild from './build';
import { gradleBuildOptionsFromFlags } from '../../lib/gradle-build-options';

test.each([false, true])('passes expo-no-clean=%s to the SDK', async (noClean) => {
  const { flags } = await Parser.parse(noClean ? ['--expo-no-clean'] : [], {
    flags: GradleBuild.flags,
  });
  expect(gradleBuildOptionsFromFlags(flags).reactNative).toEqual(noClean ? { expoNoClean: true } : undefined);
});
