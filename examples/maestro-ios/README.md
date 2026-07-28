# Maestro with Expo Go on Limrun iOS

This example runs an upstream Maestro YAML flow against a small Expo Go sample
app on a Limrun remote iOS simulator. It works with stock Maestro 2.5.x and
2.6+ (the driver port handling changed in 2.6.0; the example detects the
installed version and adapts).

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

While Expo is running, clone this example to your local in another terminal:

```bash
git clone https://github.com/limrun-inc/typescript-sdk.git
cd typescript-sdk/examples/maestro-ios
```

Export the API key and Expo URL:

```bash
export LIM_API_KEY=lim_...
export EXPO_URL='exp://...'
```

Then run:

```bash
yarn install
yarn start
```

## What The Example Does

1. Creates or reuses a remote iOS simulator with Expo Go 54 and Maestro Runner installed.
1. Launches the compatible Maestro XCTest runner if it is not already running.
1. Starts a scoped `xcrun` shim and a local HTTP forward proxy from the iOS client. The
   JVM proxy settings route Maestro's driver traffic through the proxy to the remote
   runner, so the local driver port never needs to exist.
1. Runs `maestro test --platform ios` against the Limrun simulator.

The same wiring is available as a single CLI command: `lim ios maestro test <flow>`.

The default flow lives in `flows/expo-sample.yaml`.
