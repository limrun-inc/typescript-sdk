# Maestro with Expo Go on Limrun iOS

This example runs a Maestro black-box flow against a small Expo Go sample app on
a Limrun remote iOS simulator using `@limrun/maestro-ios`. It targets the same
sample app as the Detox example: `github.com/limrun-inc/sample-detox-with-expo`.

The goal is to show a real app flow, not only a connectivity smoke test. The
flow taps buttons, types text, asserts UI state, configures a switch, and
navigates between screens.

## 1. Start The Sample React Native App

This sample Expo app exposes a public tunnel URL that the remote simulator can
open directly. There is no reverse proxy for the app under test.

```bash
git clone https://github.com/limrun-inc/sample-detox-with-expo.git
cd sample-detox-with-expo
npm install
npm run tunnel
```

If Expo asks to install tunnel support on first run, accept the prompt or run:

```bash
npm install --save-dev @expo/ngrok
```

## 2. Run The Limrun Maestro Example

Clone this repo and enter this example folder:

```bash
git clone https://github.com/limrun-inc/typescript-sdk.git
cd typescript-sdk/examples/maestro-ios
```

Export the API key and your Expo URL:

```bash
# Acquire from your Organization Settings -> API Keys
export LIM_API_KEY=lim_...
export EXPO_URL='exp://...'
```

Requirements:

- Java 17 or newer available as `java` on `PATH`
- No Gradle, Kotlin, Maestro CLI, `JAVA_HOME`, or `GRADLE_CMD` is required at runtime

The example script owns the Limrun instance lifecycle: it creates a simulator
with Expo Go preinstalled, passes the simulator API URL and token to
`@limrun/maestro-ios`, then deletes the simulator. The Maestro flow opens
`EXPO_URL`, accepts iOS's `Open in "Expo Go"?` prompt when it appears, waits for
the sample app, and drives the UI. In a repo checkout, the example `start`
script first builds the local `packages/maestro-ios` package so the gitignored
`dist` files and packaged runner JAR exist.

```bash
npm install
npm start
```

For staging:

```bash
lim-env -stg
npm start
```

## What The Example Does

1. Creates a remote iOS simulator where Expo Go 54 is installed.
2. Prints the signed stream URL that you can click and watch.
3. Starts the local Limrun-to-Maestro bridge from `@limrun/maestro-ios`.
4. Runs the packaged Maestro 2.5.1 JVM runner with `java -jar`.
5. Opens `EXPO_URL` directly in Expo Go from the Maestro flow.
6. Accepts iOS's `Open in "Expo Go"?` prompt when it appears.
7. Waits until the sample app is visible.
8. Drives the sample app with Maestro: counter, name entry, navigation, switch,
   checklist, assertions, and screenshots.
9. Writes screenshots and `summary.json` under the Maestro test output directory.
10. Deletes the remote iOS simulator from the example script.

The default flow lives in `flows/expo-sample.yaml`.

For direct package CLI usage against an existing Limrun iOS target, see
`../../packages/maestro-ios/README.md`.
