# XCode Sandbox + iOS Simulator

You and your agents can now develop iOS apps without a Mac.

This example shows how you can create a Limrun iOS Simulator and XCode
sandbox that are connected to each other where your local code is automatically
synced, built and hot-reloaded on every change.

### Pre-requisites

No macOS.

We utilize `xdelta3` algorithm for differential patching, so it needs to be
installed in the environment.

Mac:

```bash
brew install xdelta
```

Ubuntu:

```bash
sudo apt-get install xdelta3
```

### Run

You can get an API key from [Limrun Console](https://console.limrun.com)

```bash
export LIM_API_KEY=<lim token from Console>
```

```bash
yarn install
```

```bash
NATIVE_APP_CODE_DIR="<directory where your app code resides>"
yarn run start $NATIVE_APP_CODE_DIR
```

Go to the printed iOS simulator link to see your app.

As you make changes on source files, we automatically sync it so by the time you or
your agent is done with code changes, all is already in the sandbox.

Add this as an MCP server to your agent so that it can trigger a build on its own!

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
