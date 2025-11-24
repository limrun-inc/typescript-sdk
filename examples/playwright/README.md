# Using Playwright Android to Automate Chrome & WebViews

This example shows how to enable the Playwright Android sandbox feature
so that the Chrome Developer Protocol (CDP) communication happens
with very low latency while your test code still runs wherever you'd like.

## Quick Start

This example relies on having an app that embeds a WebView. If you don't have
any readily available, you can download [WebView Shell](https://storage.googleapis.com/chromium-browser-snapshots/index.html?prefix=AndroidDesktop_x64/1549337/) app
and push to your asset storage with the following commands:
```bash
unzip AndroidDesktop_x64_1549337_chrome-android-desktop.zip
# Install lim via `brew install limrun-inc/tap/lim`
lim push chrome-android-desktop/apks/SystemWebViewShell.apk
```

Once the `lim push` command succeeds, we can continue.

1. Get an API Key from `Limrun Console` > `Settings` page [here](https://console.limrun.com/settings).
1. Make it available as environment variable.
   ```bash
   export LIM_API_KEY="you api key"
   ```
1. Run the test.
   ```bash
   npm run start
   ```

### Alternative

You can always opt into starting an ADB tunnel and connect Playwright locally
like the following, but it is known to be slower as CDP traffic is quite chatty
and Playwright's current Android integration makes aggressive calls that add up
if you're not in the same continent.
```ts
// Talks with ADB directly and starts CDP connection
const [device] = await android.devices();
console.log(`Model: ${device.model()}`);
console.log(`Serial: ${device.serial()}`);
```