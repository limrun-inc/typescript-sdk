import type { ExecChildProcess } from '@limrun/api/exec-client';

export type BuildPlatform = 'gradle' | 'xcode';
type BuildOutcome = { exitCode?: number; status?: string; timedOut?: boolean };

const snapshot =
  ' Use --snapshot-key <key> when creating the sandbox to persist the disk and restore it in later runs.';
const include =
  'You can include ignored files with --include <pattern>, a regular expression relative to the sync root.';
const fileSecret =
  "You can create a secret with lim secret create <name> --file <local-file> and bind it with --file-from-secret 'path=<name>'.";
const registry =
  "You can use --env NAME=<value> when your registry config reads it, or create a config secret with lim secret create <name> --file <local-npmrc> and bind it with --file-from-secret '~/.npmrc=<name>'.";
const root = 'You can select the Gradle project inside the synced workspace with --project-path <directory>.';
const wrapperMode =
  "You can restore the wrapper's executable bit locally with chmod +x <wrapper-path> and sync the project again.";
const signing =
  "You can supply a signing key with --keystore, --key-alias, --keystore-password and --key-password. Or create a secret with lim secret create <name> --file <local-keystore> and bind it with --file-from-secret 'path=<name>'.";
const androidSDK =
  "You can list Android SDK packages with lim gradle run -- sdkmanager --list and install a package required by your project with lim gradle run -- sdkmanager '<package>'.";
const memory =
  'You can reduce Gradle worker concurrency with org.gradle.workers.max and configure Gradle/Kotlin JVM memory limits in gradle.properties. You can pass GRADLE_OPTS through --env to override the automatic Gradle heap adjustment.';

// Suggestions are static. Customer output must never become a command suggestion.
const rules = [
  {
    pattern: new RegExp(
      '(?:ERR_PNPM_FETCH_(?:401|403)\\b|npm (?:ERR!|error) code E(?:401|403)\\b|YN0041:.*Invalid authentication|pnpm: Private npm credentials are missing or expired)',
      'm',
    ),
    hints: [registry],
    snapshot: false,
  },
  {
    pattern: new RegExp('ERR_PNPM_MISSING_TARBALL_INTEGRITY\\b', 'm'),
    hints: [
      "You can select your project's pnpm version with lim %s use pnpm@<version> and persist it in mise.limrun.toml.",
    ],
    snapshot: true,
  },
  {
    pattern: new RegExp(
      '(?:ERR_PNPM_UNSUPPORTED_ENGINE\\b|error: invalid source release: [0-9]+|Unsupported class file major version [0-9]+|Unrecognized or legacy configuration settings found:.*approvedGitRepositories|rustup could not choose a version.*no default is configured)',
      'm',
    ),
    hints: [
      "You can select your project's tool version with lim %s use <tool>@<version> and persist it in mise.limrun.toml.",
    ],
    snapshot: true,
  },
  {
    pattern: new RegExp('ERR_PNPM_NO_MATCHING_VERSION.*(?:@pnpm/|pnpm@)', 'm'),
    hints: [
      "You can select your project's pnpm version with lim %s use pnpm@<version> and persist it in mise.limrun.toml.",
    ],
    snapshot: true,
  },
  {
    pattern: new RegExp(
      "(?:Failed to find target with hash string 'android-[^']+'|Failed to find Build Tools revision [0-9])",
      'm',
    ),
    hints: [androidSDK],
    snapshot: false,
  },
  {
    pattern: new RegExp('(?:fatal: not a git repository|fatal: .*must be run in a work tree)', 'im'),
    hints: [
      "You can include Git metadata with --include '^\\.git(/|$)'. A worktree .git file may refer to a directory outside the sync root.",
    ],
    snapshot: false,
  },
  {
    pattern: new RegExp('(?:ENOENT:.*google-services\\.json|File google-services\\.json is missing)', 'im'),
    hints: [include, fileSecret],
    snapshot: false,
  },
  {
    pattern: new RegExp(
      '(?:Unable to access jarfile .*gradle-wrapper\\.jar|Could not find or load main class org\\.gradle\\.wrapper\\.GradleWrapperMain)',
      'im',
    ),
    hints: [include, root],
    snapshot: false,
  },
  {
    pattern: new RegExp('^gradlew wrapper not found or not executable at the Gradle root', 'm'),
    hints: [include, root, wrapperMode],
    snapshot: false,
  },
  { pattern: new RegExp('gradlew: Permission denied', 'im'), hints: [wrapperMode], snapshot: false },
  {
    pattern: new RegExp('local\\.properties.*(?:does not exist|not found|no such file)', 'im'),
    hints: [
      include,
      'You can sync an external file with --additional-file localPath=remotePath. SDK paths in local.properties need to refer to the remote environment.',
    ],
    snapshot: false,
  },
  {
    pattern: new RegExp(
      "(?:cordova\\.variables\\.gradle.*(?:does not exist|not found|no such file)|Project with path ':capacitor[^']*' could not be found|No matching variant of project :capacitor[^ ]* was found)",
      'im',
    ),
    hints: [
      include,
      "You can run the project's Capacitor sync command inside the sandbox with lim %s run -- <command>.",
    ],
    snapshot: true,
  },
  {
    pattern: new RegExp('capacitor\\.config\\.json.*(?:no such file|does not exist|not found)', 'im'),
    hints: [
      include,
      "You can run the project's Capacitor sync command inside the sandbox with lim %s run -- <command>.",
    ],
    snapshot: true,
  },
  {
    pattern: new RegExp("Project with path ':[^']+' could not be found", 'm'),
    hints: [include],
    snapshot: false,
  },
  {
    pattern: new RegExp(
      '(?:Keystore file .*not found|SigningConfig .*missing required property.*storeFile|storeFile.*is not set)',
      'im',
    ),
    hints: [signing],
    snapshot: false,
  },
  {
    pattern: new RegExp('OutOfMemoryError: Metaspace', 'm'),
    hints: [
      'You can configure the JVM class-metadata budget with -XX:MaxMetaspaceSize in the relevant Gradle or Kotlin JVM arguments. This is separate from the -Xmx heap budget.',
      memory,
    ],
    snapshot: false,
  },
  {
    pattern: new RegExp('OutOfMemoryError: (?:Java heap space|GC overhead limit exceeded)', 'm'),
    hints: [memory],
    snapshot: false,
  },
  {
    pattern: new RegExp('error: An organization (?:ID or slug|slug).*required', 'im'),
    hints: [
      'You can set --env SENTRY_ORG=<slug>. For auth, you can use --env SENTRY_AUTH_TOKEN=<value>, or create a secret with lim secret create <name> --stdin and bind it with --env-from-secret SENTRY_AUTH_TOKEN=<name>.',
    ],
    snapshot: false,
  },
  {
    pattern: new RegExp(
      'python3_bin_reldir\\.txt.*(?:not found|does not exist|no such file)|depot_tools.*not.*initialized',
      'im',
    ),
    hints: [
      'You can run the depot_tools bootstrap command named in the error inside the sandbox with lim %s run -- <command>.',
    ],
    snapshot: true,
  },
  {
    pattern: new RegExp(
      '(?:cannot run ssh: No such file or directory|cannot spawn ssh: No such file or directory)',
      'im',
    ),
    hints: [
      "You can switch to an HTTPS Git URL. For credentials, you can use --env NAME=<value> if your setup reads it, or create a secret with lim secret create <name> --file <local-netrc> and bind it with --file-from-secret '~/.netrc=<name>'.",
    ],
    snapshot: false,
  },
  {
    pattern: new RegExp(
      "(?:Cannot find module ['\"](?:react-native/package\\.json|expo[^'\"]*)['\"]|Plugin \\[id: 'expo-module-gradle-plugin'\\] was not found|Cannot find module ['\"][^'\"]*/expo/bin/cli['\"]|Could not find an existing 'expo' binary to run)",
      'im',
    ),
    hints: [
      'You can select an Expo app with --expo-app-dir <directory>, which enables the dependency-install and native-prebuild pipeline.',
    ],
    snapshot: true,
  },
];

const maxBytes = 1 << 20;
const maxLineChars = 8192;
const ansi = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Keeps only the final command's recent output; SDK streams and results stay untouched. */
export class BuildFailureHints {
  private chunks: Buffer[] = [];
  private bytes = 0;

  constructor(
    private readonly platform: BuildPlatform,
    proc?: Pick<ExecChildProcess, 'command' | 'stdout' | 'stderr'>,
  ) {
    if (proc) {
      for (const type of ['command', 'stdout', 'stderr'] as const) {
        proc[type].on('data', (data: string) => this.addEvent({ type, data }));
      }
    }
  }

  addEvent(event: { type: string; data: string }): void {
    if (event.type === 'command') {
      this.chunks = [];
      this.bytes = 0;
      return;
    }
    if (event.type !== 'stdout' && event.type !== 'stderr') return;
    const data = Buffer.from((event.data.endsWith('\n') ? event.data : event.data + '\n').slice(-maxBytes));
    this.chunks.push(Buffer.from(data.subarray(Math.max(0, data.length - maxBytes))));
    this.bytes += Math.min(data.length, maxBytes);
    while (this.bytes > maxBytes) {
      const first = this.chunks[0]!;
      const remove = Math.min(first.length, this.bytes - maxBytes);
      if (remove === first.length) this.chunks.shift();
      else this.chunks[0] = first.subarray(remove);
      this.bytes -= remove;
    }
  }

  addPersistedLog(log: string): void {
    // Raw persisted logs prefix each command with "$ ". A possible command boundary
    // discards earlier diagnostics rather than blaming a later failure on old output.
    for (const line of log.slice(-maxBytes).split('\n')) {
      this.addEvent({ type: line.startsWith('$ ') ? 'command' : 'stdout', data: line });
    }
  }

  getHints(result: BuildOutcome): string[] {
    if (
      result.exitCode === undefined ||
      result.exitCode <= 0 ||
      result.timedOut ||
      (result.status !== undefined && result.status !== 'FAILED')
    )
      return [];
    // Cap individual lines too: JavaScript regex matching is not RE2's linear-time engine.
    const lines = Buffer.concat(this.chunks)
      .toString('utf8')
      .replace(ansi, '')
      .split('\n')
      .map((line) => line.slice(-maxLineChars));
    const diagnostic = lines.join('\n');
    if (
      diagnostic.includes('Network is unreachable') ||
      diagnostic.includes('java.net.UnknownHostException:')
    )
      return [];
    if (
      result.exitCode === 124 &&
      diagnostic.trimEnd().split('\n').pop()?.startsWith('command timed out after ')
    ) {
      return [
        `You can set a run command's deadline with lim ${this.platform} run --timeout <seconds>, up to 21600 seconds.`,
      ];
    }
    const resultHints = new Set<string>();
    for (const rule of rules) {
      if (!lines.some((line) => rule.pattern.test(line))) continue;
      for (let i = 0; i < rule.hints.length; i++) {
        let hint = rule.hints[i]!;
        if (this.platform !== 'gradle' && [root, signing, androidSDK].includes(hint)) continue;
        if (rule.snapshot && this.platform === 'xcode' && i === rule.hints.length - 1) hint += snapshot;
        hint = hint.replace(/%s/g, this.platform);
        // Older daemons can already have emitted this hint during a rolling upgrade.
        resultHints.add(hint);
        if (resultHints.size === 3)
          return [...resultHints].filter((hint) => !diagnostic.includes('Hint: ' + hint));
      }
    }
    return [...resultHints].filter((hint) => !diagnostic.includes('Hint: ' + hint));
  }
}

export function printBuildHints(hints: readonly string[]): void {
  for (const hint of hints) process.stderr.write(`Hint: ${hint}\n`);
}
