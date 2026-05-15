# @limrun/maestro-ios

Run Maestro YAML flows against Limrun-hosted iOS simulators.

```bash
export LIMRUN_IOS_API_URL=https://...
export LIMRUN_IOS_TOKEN=lim_...
npx @limrun/maestro-ios test flows/hacker-news.yaml
```

Optional first-release flags:

```bash
npx @limrun/maestro-ios test flows/hacker-news.yaml \
  --test-output-dir artifacts/limrun-maestro
```

The package connects to an existing Limrun iOS simulator, starts a local bridge, runs the bundled Maestro 2.5.1 engine through `java -jar`, and writes screenshots, logs, and `summary.json` under the test output directory. It does not create or delete Limrun instances.

## Requirements

- Node/npm via `npx`
- Java 17 or newer available as `java` on `PATH`
- `LIMRUN_IOS_API_URL`
- `LIMRUN_IOS_TOKEN`

You do not need Gradle, Kotlin, the Maestro CLI, a local Maestro checkout, `JAVA_HOME`, or `GRADLE_CMD` at runtime.

## Boundaries

This is an iOS-only runner package for one entry Maestro YAML flow file. The public CLI intentionally stays close to `maestro test`: use `--test-output-dir` for run artifacts. Instance lifecycle is intentionally out of scope for this package. Create, reuse, or delete instances in your surrounding script or CI job. It does not install apps yet. For non-system apps, install or build the app in a previous step, then launch it from the flow by bundle id. The bundled Maestro version is the compatibility contract for this release line: `@limrun/maestro-ios@2.5.1-lim.1` runs Maestro `2.5.1`.

## Support Matrix

Implemented:

- App lifecycle: `launchApp`, `stopApp`, `killApp`
- Interaction: `tapOn`, point taps, `longPressOn`, `inputText`, random input commands, `pressKey`, `eraseText`, `hideKeyboard`
- Navigation/system: `openLink`, `setOrientation`
- Gestures: `scroll`, `scrollUntilVisible`, `swipe`
- Assertions and waits backed by hierarchy reads: `assertVisible`, `assertNotVisible`, `extendedWaitUntil`, `assertTrue`, `assertScreenshot`
- Artifacts: `takeScreenshot`, `startRecording`, `stopRecording`
- Flow composition inside that entry flow is handled by Maestro: `repeat`, `retry`, relative `runFlow` includes, `runScript`, `evalScript`, `onFlowStart`, `onFlowComplete`, environment variables
- Clipboard flows handled by Maestro when they reduce to hierarchy reads or text input: `copyTextFrom`, `pasteText`

Best-effort:

- `clearState` uses Limrun `softReset` data strategy and relaunches the app.
- `hideKeyboard` sends Escape.
- Keyboard visibility reports false because Limrun iOS does not expose keyboard state yet.
- Screen-static and app-settle waits use conservative waits instead of pixel stability.
- Direction and element swipes map to Limrun scroll primitives.
- `launchApp` does not support non-empty `launchArguments` yet.

Unsupported commands fail loudly. v0.1 explicitly defers keychain clearing, permission mutation, adding media, location simulation, proxy commands, airplane mode, Android-specific behavior, and AI commands.
