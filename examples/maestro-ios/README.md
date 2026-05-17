# Maestro with Expo Go on Limrun iOS

This example runs an upstream Maestro YAML flow against a small Expo Go sample
app on a Limrun remote iOS simulator.

It targets
[github.com/limrun-inc/sample-expo-test-app](https://github.com/limrun-inc/sample-expo-test-app),
the same controlled app used by the other Limrun mobile automation examples.

## 1. Start The Sample React Native App

The sample Expo app should expose a public `exp://` URL that the remote simulator
can open directly.

```bash
git clone https://github.com/limrun-inc/sample-expo-test-app.git
cd sample-expo-test-app
npm install
npm run tunnel
```

If Expo asks to install tunnel support on first run, accept the prompt or run:

```bash
npm install --save-dev @expo/ngrok
```

## 2. Run The Limrun Maestro Example

Export the API key and Expo URL:

```bash
export LIM_API_KEY=lim_...
export EXPO_URL='exp://...'
```

Requirements:

- Upstream `maestro` installed on `PATH`.

The package first looks for the public App Store asset
`appstore/maestro-ios-runner-<maestro-version>.tar.gz`. Since `appstore/` is
reserved, `@limrun/maestro` bundles a matching runner and idempotently seeds it
as the regular asset `maestro-ios-runner-2.5.1.tar.gz` when it is missing.

Then run:

```bash
yarn install
yarn start
```

Set `LIMRUN_KEEP_INSTANCE=true` to keep the simulator after the run.

## What The Example Does

1. Creates or reuses a remote iOS simulator with Expo Go 54 installed.
2. Prints the signed stream URL that you can watch.
3. Uses `@limrun/maestro` to install and launch the compatible Maestro XCTest runner.
4. Starts a local proxy and scoped `xcrun` shim for upstream Maestro.
5. Runs `maestro test --platform ios` against the Limrun simulator.
6. Opens `${MAESTRO_EXPO_URL}`, accepts the iOS `Open` prompt, waits for the
   sample app, and drives the UI.

The default flow lives in `flows/expo-sample.yaml`.
