# Detox with Expo Go on Limrun iOS

This example runs Detox tests against a small Expo Go sample app on a Limrun
remote iOS simulator. It is intentionally opinionated: the test targets
`github.com/limrun-inc/sample-detox-with-expo`, a controlled app with stable
React Native `testID`s.

The goal is to show a real Detox flow, not only a connectivity smoke test. The
test taps buttons, types text, asserts UI state, configures a switch, and
navigates between screens.

## 1. Start The Sample App

Clone the sample React Native app next to your SDK checkout:

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

Set `LIMRUN_KEEP_INSTANCE=true` to keep the Limrun instance after the run for
inspection.

## What The Example Does

1. Creates or reuses a Limrun iOS instance with Expo Go 54 installed.
2. Prints the Limrun stream URL when the instance provides one.
3. Starts `detox run-server` locally.
4. Starts a reverse tunnel from the simulator to the local Detox mediator.
5. Runs `detox test` with the Limrun Detox driver.
6. From Jest setup, launches Expo Go with the typed Limrun Detox runtime.
7. Opens `EXPO_URL` and accepts Expo Go's `Open in "Expo Go"?` prompt when it appears.
8. Drives the sample app with Detox: counter, name entry, navigation, switch,
   checklist, and assertions.

Detox configuration and env wiring live in `e2e/` and `.detoxrc.cjs` beside
this README.
