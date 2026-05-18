# Detox with Expo Go on Limrun iOS

This example runs Detox tests against a small Expo Go sample app on a Limrun
remote iOS simulator. It is intentionally opinionated: the test targets
`github.com/limrun-inc/sample-detox-with-expo`, a controlled app with stable
React Native `testID`s.

The goal is to show a real Detox flow, not only a connectivity smoke test. The
test taps buttons, types text, asserts UI state, configures a switch, and
navigates between screens.

## 1. Start The Sample React native App

This is sample Expo app with public URL to connect, you can use your own Expo
app with a public `exp://` URL for simulator to connect.

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

## 2. Run The Limrun Detox Example

Clone this repo and enter this example folder:

```bash
git clone https://github.com/limrun-inc/typescript-sdk.git
cd typescript-sdk/examples/detox-ios
```

Export the API key and your Expo URL:

```bash
export LIM_API_KEY=lim_...
export EXPO_URL='exp://...'
```

Start the test!

```bash
yarn install
yarn start
```

## What The Example Does

1. Creates a remote iOS simulator where Expo Go 54 installed.
2. Prints the signed stream URL that you can click and watch.
3. Starts `detox run-server` locally.
4. Starts a reverse tunnel from the simulator to the local Detox mediator.
   The Detox traffic goes through a private HTTPS tunnel.
5. Runs `detox test` with the Limrun Detox driver.
6. From Jest setup, launches Expo Go with the typed Limrun Detox runtime.
7. Opens `EXPO_URL` and accepts Expo Go's `Open in "Expo Go"?` prompt when it appears.
8. Drives the sample app with Detox: counter, name entry, navigation, switch,
   checklist, and assertions.

Detox configuration and env wiring live in `e2e/` and `.detoxrc.cjs` along
this README.
