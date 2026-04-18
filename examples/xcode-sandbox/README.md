# Xcode Instance

Build iOS apps in the cloud without a Mac using a standalone Xcode instance.

This example creates a Limrun Xcode instance, syncs your local code,
and builds it remotely for either the iOS simulator or a real device.

Clone this repo and get started!

```bash
git clone https://github.com/limrun-inc/typescript-sdk.git
cd typescript-sdk/examples/xcode-sandbox
```

### Run

Clone our sample Swift-based native app.

```bash
git clone https://github.com/limrun-inc/sample-native-app.git
```

Get an API key from [Limrun Console](https://console.limrun.com)

```bash
export LIM_API_KEY=<lim token from Console>
```

```bash
yarn install
```

Start the sandbox. This creates the Xcode instance, syncs your code, runs an
initial simulator build, and starts an HTTP server on port 3000:

```bash
yarn run start sample-native-app/
```

As you make changes on source files, we automatically sync them so by the time
you or your agent is done with code changes, all is already synced.

Trigger a simulator build:

```bash
curl http://localhost:3000/xcodebuild
```

Trigger a real device build and get a signed download URL for the IPA:

```bash
curl "http://localhost:3000/xcodebuild?sdk=iphoneos&assetName=device-build.ipa"
```

> Tip: Use `attachSimulator()` for hot-reloading builds on a simulator for fast
> iteration. Alternatively, create the simulator with `sandbox.xcode.enabled=true`.

Enjoy!
