# XCode Sandbox + iOS Simulator

You and your agents can now develop iOS apps without a Mac.

This example shows how you can create a Limrun iOS Simulator and XCode
sandbox that are connected to each other where your local code is automatically
synced, built and hot-reloaded on every change.

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

```bash
yarn run start sample-native-app/
```

Go to the printed iOS simulator URL to see your app.

As you make changes on source files, we automatically sync it so by the time you or
your agent is done with code changes, all is already in the sandbox.

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
