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

Build the SDK from this checkout, then install the example dependencies:

```bash
(cd ../.. && yarn install --ignore-scripts && yarn build)
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
curl "http://localhost:3000/xcodebuild?sdk=iphoneos&target=name/xcode-example/device-build.ipa"
```

The instance receives explicit `spec.role.permissions` for creating, uploading,
and updating assets under `xcode-example/`. The caller needs `asset:*:create`,
`asset:*:upload`, and `asset:*:update` (or broader grants) to delegate these name
patterns. Every build sends a concrete `upload.target`, such as
`name/xcode-example/device-build.ipa`; the permission pattern does not choose the
upload destination. Names are literal: do not percent-encode the target passed to
the SDK. Normal URL query escaping still applies to the HTTP example above.

The example fetches the download URL afterward using the caller's asset read
permission. The workload itself receives no read or delete permission. For a
single allowed output, replace each `xcode-example/*` grant with that exact name.

> Tip: Use `attachSimulator()` for hot-reloading builds on a simulator for fast
> iteration.

Enjoy!
