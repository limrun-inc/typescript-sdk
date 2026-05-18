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
npx expo start --tunnel --port 8090
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

The example creates the simulator with Expo Go and the compatible Maestro XCTest
runner asset already installed.

Then run:

```bash
yarn install
yarn start
```

Set `LIMRUN_KEEP_INSTANCE=true` to keep the simulator after the run.

## What The Example Does

1. Creates or reuses a remote iOS simulator with Expo Go 54 installed.
2. Prints the signed stream URL that you can watch.
3. Launches the compatible Maestro XCTest runner if it is not already running.
4. Starts a scoped `xcrun` shim and local HTTP proxy from the iOS client for upstream Maestro.
5. Runs `maestro test --platform ios` against the Limrun simulator.
6. Opens `${MAESTRO_EXPO_URL}`, accepts the iOS `Open` prompt, waits for the
   sample app, and drives the UI.

The default flow lives in `flows/expo-sample.yaml`.
