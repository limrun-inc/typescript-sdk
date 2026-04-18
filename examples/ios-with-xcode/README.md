# iOS Instance with Xcode

Build and run iOS apps using an iOS instance with an embedded Xcode sandbox.

This example creates a Limrun iOS instance with Xcode enabled, syncs your
local code, builds it remotely, and installs the app on the simulator.

Clone this repo and get started!

```bash
git clone https://github.com/limrun-inc/typescript-sdk.git
cd typescript-sdk/examples/ios-with-xcode
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

```bash
yarn run start sample-native-app/
```

Go to the printed iOS simulator URL to see your app.

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
