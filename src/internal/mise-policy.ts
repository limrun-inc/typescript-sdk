// Generated from limrun/pkg/build/mise/policy.json by scripts/sync-mise-policy.mjs.
export const misePolicy = {
  aliases: {
    nodejs: 'node',
    jdk: 'java',
    'gem:bundler': 'bundler',
    'gem:cocoapods': 'cocoapods',
    'gem:cocoapods-patch': 'cocoapods-patch',
  },
  excludedTools: ['xcode', 'swift', 'brew', 'homebrew'],
  minorSensitiveTools: ['ruby', 'python', 'go', 'flutter', 'dart'],
  vendorPrefixes: {
    java: {
      jetbrains: 'jetbrains',
      jbr: 'jetbrains',
      corretto: 'corretto',
      temurin: 'temurin',
      openjdk: 'openjdk',
      zulu: 'zulu',
      liberica: 'liberica',
      graalvm: 'graalvm',
    },
  },
  numericVersionPattern: '^v?([0-9]+)(?:\\.([0-9]+))?(?:\\.[0-9]+)*(?:[-+][A-Za-z0-9._+-]+)?$',
};
