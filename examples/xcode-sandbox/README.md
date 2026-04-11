# Xcode Instance

Build iOS apps in the cloud without a Mac using a standalone Xcode instance.

This example creates a Limrun Xcode instance, syncs your local code,
and builds it remotely. Optionally attach an iOS simulator to preview
builds on device.

Clone this repo and get started!

```bash
git clone https://github.com/limrun-inc/typescript-sdk.git
cd typescript-sdk/examples/xcode-sandbox
```

### Pre-requisites

We utilize `xdelta3` algorithm for differential patching, so it needs to be
installed in the environment.

```bash
# macOS
brew install xdelta
```

```bash
# Ubuntu/Debian
sudo apt-get install xdelta3
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

Build and upload artifact:

```bash
yarn run start sample-native-app/ --asset-name=my-app-build
```

Build and install on an iOS simulator:

```bash
yarn run start sample-native-app/ --simulator
```

As you make changes on source files, we automatically sync it so by the time you or
your agent is done with code changes, all is already synced.

Trigger a manual build:

```bash
curl http://localhost:3000/xcodebuild
```

Let your agent trigger a build on its own:

```json
{
  "mcpServers": {
    "xcode": {
      "url": "http://localhost:3000/"
    }
  }
}
```

```bash
claude mcp add xcode --transport http http://localhost:3000
```

Enjoy!
