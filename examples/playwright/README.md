# Using Playwright Android to Automate Chrome & WebViews

This example shows how to enable the Playwright Android sandbox feature
so that the Chrome Developer Protocol (CDP) communication happens
with very low latency while your test code still runs wherever you'd like.

It opens Chrome, goes to [Playwright](https://github.com/microsoft/playwright)
does a couple clicks and deletes the instance.

## Quick Start

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
