# Detox with Expo Go on Limrun iOS

This example runs Detox tests against a small Expo Go sample app on a Limrun
remote iOS simulator. It is intentionally opinionated: the test targets
`github.com/limrun-inc/sample-detox-with-expo`, a controlled app with stable
React Native `testID`s.

The goal is to show a real Detox flow, not only a connectivity smoke test. The
test taps buttons, types text, asserts UI state, navigates, toggles state, and
writes screenshots while the Limrun stream shows the simulator moving in real
time.

## 1. Start The Sample App

Clone the sample app next to your SDK checkout:

```bash
git clone https://github.com/limrun-inc/sample-detox-with-expo.git
cd sample-detox-with-expo
npm install
npm run tunnel
```

The sample app's `tunnel` script runs Expo on port `8090` with a public tunnel.
Copy the `exp://...` URL printed by Expo CLI. If Expo asks to install tunnel
support on first run, accept the prompt or run:

```bash
npm install --save-dev @expo/ngrok
```

The sample app intentionally avoids custom native modules so it can run inside
Expo Go.

## 2. Run The Limrun Detox Example

In a second terminal:

```bash
cd path/to/typescript-sdk/examples/detox-ios
export LIM_API_KEY=lim_...
export EXPO_URL='exp://...'
yarn install
yarn start
```

For this repo-local example, `yarn start` and `yarn build` first build
`../../packages/detox`, which in turn builds the root SDK. A clean checkout does
not depend on ignored `dist` directories already existing.

## What The Example Does

1. Creates or reuses a Limrun iOS instance with Expo Go 54 installed.
2. Prints the Limrun stream URL when the instance provides one.
3. Starts `detox run-server` locally.
4. Starts a reverse tunnel from the simulator to the local Detox mediator.
5. Runs `detox test` with the Limrun Detox driver.
6. From Jest setup, launches Expo Go with the typed Limrun Detox runtime.
7. Opens `EXPO_URL` and accepts Expo Go's `Open in "Expo Go"?` prompt when it appears.
8. Drives the sample app with Detox:
   - verifies the home screen
   - taps increment/decrement controls
   - types and submits a name
   - navigates to a detail screen
   - toggles a switch and completes a checklist item
   - asserts the final success state
9. Writes stdout, stderr, Detox artifacts, screenshots, and a JSON summary under
   `artifacts/limrun-detox`.

The ordering matters: the Detox tester connects to the mediator before Expo Go's
native Detox client connects. That avoids benign but scary mediator messages
from app-side messages arriving before any tester is present.

## Demo Setup

For a live or recorded demo, put two panes side by side:

- Left pane: terminal running `yarn start` in this directory.
- Right pane: the Limrun stream URL printed by the example.

The terminal should end with a passing Detox test and artifact paths. The stream
should visibly show the app being tapped, typed into, navigated, and completed.

Expected terminal shape:

```text
PASS e2e/sample-app.test.js
  Limrun Detox Expo sample app
    ✓ drives the sample Expo app on a Limrun iOS simulator

Limrun Detox demo complete
Artifacts: artifacts/limrun-detox
Screenshots: artifacts/limrun-detox/detox-artifacts (4 files)
Logs: artifacts/limrun-detox/{detox.stdout.log,detox.stderr.log,detox.summary.json}
Deleted instance: ios_...
```

## Artifacts

The runner writes:

- `artifacts/limrun-detox/detox.stdout.log`
- `artifacts/limrun-detox/detox.stderr.log`
- `artifacts/limrun-detox/detox.summary.json`
- `artifacts/limrun-detox/detox-artifacts/`

The sample test takes named screenshots:

- `limrun-detox-home`
- `limrun-detox-counter`
- `limrun-detox-greeting`
- `limrun-detox-success`

Set `DETOX_ARTIFACTS_DIR` to write these somewhere else.

Set `DETOX_LOGLEVEL=debug` or `DETOX_LOGLEVEL=trace` when you need deeper Detox
logs. The example defaults Detox logs to `verbose` as a middle ground for demos.
Detox 20.x does not expose a concise native "tap/expect/type" step logger;
`trace` is the native option, but it prints low-level protocol traffic.

Set `LIMRUN_BUILD_TRACE=true` if you need shell tracing from the root SDK build.

## Keeping The Instance

By default the example deletes the Limrun instance after the run. Set:

```bash
export LIMRUN_KEEP_INSTANCE=true
```

to keep the instance for inspection.

## Expo Go vs Development Builds

Expo Go is useful when your app only needs Expo Go's bundled native modules and
you already have a URL that the remote simulator can open. It is the fastest
demo path because Limrun only needs to install Expo Go and open your project
URL.

Use an Expo development build or a full React Native simulator build when:

- your app includes custom native modules not bundled in Expo Go
- you need app-specific native configuration, entitlements, or URL schemes
- you want production-like startup behavior instead of Expo Go's shell
- you need deterministic app installation/reset semantics across repeated runs

The Detox driver does not own the iOS device lifecycle yet. This example prepares
the Limrun instance first, then runs stock Detox test code against that prepared
session.
