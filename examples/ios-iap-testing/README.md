# IAP testing on iOS Simulator

Test in-app purchases on a remote Limrun iOS simulator using StoreKit's
local test environment — no real Apple Account, no sandbox, no real
money movement. Products appear, `Buy` sheets label themselves
`[Environment: Xcode]`, and purchases complete locally.

The example creates an iOS instance with an embedded Xcode sandbox, syncs
your source folder, and runs `xcodebuild` server-side (ad-hoc signed so
StoreKit's local test environment accepts the bundle).

Two flows are supported:

1. **Explicit** — you already have a `.storekit` file (e.g. the one Xcode
   generates via *File → New → StoreKit Configuration File → Sync with
   App Store Connect*). The script uploads it with `setStoreKitConfig`.
2. **Discover** — you don't have a `.storekit` on hand. The script runs
   `discoverStoreKitConfig`, which polls the simulator's cached sandbox
   response and auto-generates one. Requires the bundle to have IAPs
   registered in App Store Connect sandbox and the app to trigger a
   product fetch (typically by opening the paywall) during the wait
   window.

## Quick Start

Clone this repo and enter this example folder:

```bash
git clone https://github.com/limrun-inc/typescript-sdk.git
cd typescript-sdk/examples/ios-iap-testing
```

Clone [RevenueCat's StoreKit Views demo](https://github.com/RevenueCat-Samples/storekit-views-demo-app)
— a minimal SwiftUI paywall (MIT) that ships a `StoreKitConfiguration.storekit`
with products `pro_monthly`, `pro_yearly`, `pro_weekly`, `pro_lifetime`. The
bundled `.storekit` drives the explicit flow; register the same IDs in your
App Store Connect sandbox to drive the discover flow.

```bash
git clone https://github.com/RevenueCat-Samples/storekit-views-demo-app.git
```

Set your API key and install dependencies:

```bash
export LIM_API_KEY=<lim token from Console>
yarn install
```

### Explicit flow (with a `.storekit`)

```bash
yarn run start "storekit-views-demo-app/StoreKit Views Demo" \
  --bundle-id com.revenuecat.storekit-views-demo.StoreKit-Views-Demo \
  --storekit "storekit-views-demo-app/StoreKit Views Demo/StoreKit Views Demo/StoreKitConfiguration.storekit"
```

Output:

```
Instance ready: https://console.limrun.com/stream/ios_xyz
Syncing code from storekit-views-demo-app/StoreKit Views Demo...
Building with xcodebuild (ad-hoc signed server-side)...
...
Build succeeded. Installed: com.revenuecat.storekit-views-demo.StoreKit-Views-Demo
Registering StoreKit config from .../StoreKitConfiguration.storekit...

Open the paywall in the app — products should now come from the
local test environment (no Apple Account dialog, no sandbox).
```

### Discover flow (no `.storekit`)

```bash
yarn run start "storekit-views-demo-app/StoreKit Views Demo" \
  --bundle-id com.revenuecat.storekit-views-demo.StoreKit-Views-Demo
```

Output:

```
Instance ready: https://console.limrun.com/stream/ios_xyz
...
Build succeeded. Installed: com.revenuecat.storekit-views-demo.StoreKit-Views-Demo

No --storekit supplied — running server-side discover.
Open the paywall in the app at https://console.limrun.com/stream/ios_xyz
Waiting up to 120s for a StoreKit product fetch...
```

Open the link, drive the app to its paywall, and wait. The server
detects the cached sandbox response, translates it into a `.storekit`,
and registers it:

```
Discovered 2 items → 0 products + 2 subscriptions across 1 groups.

Reopen the paywall — products should now come from the local test
environment (no Apple Account dialog, no sandbox).
```

Tune the wait window with `--timeout <seconds>` (default 120, server cap 300).
