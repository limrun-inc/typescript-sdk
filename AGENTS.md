# Agent Instructions

Make sure to run "./scripts/lint" before pushing a commit.

We use yarn as our package manager.

## Keep the Go SDK in sync

The Go SDK (github.com/limrun-inc/go-sdk) offers the same instance clients and helpers as this SDK.
A change to either SDK lands in the other one too, in the same piece of work:

- New or changed instance client calls, options, result fields and wire messages
  (`src/ios-client.ts`, `src/instance-client.ts` and the Go `websocket/ios` and `websocket/android` packages).
- Helpers built on those clients, such as the `xcrun` shims, the Maestro wiring and the Argent bridge.
- Behavior and bug fixes. A bug fixed in one SDK is fixed in both.

Open the two pull requests together and link each from the other. Use the same names, adjusted to each
language's conventions (`startArgentBridge` and `StartArgentBridge`), and the same defaults.

Some files are shared verbatim. Edit both copies and keep them byte-identical:

- The script `xcrunShimSource()` in `src/ios-shim.ts` renders without options, and `websocket/ios/shim/xcrun.js`
  in the Go SDK.
- `ARGENT_XCRUN_SHIM` in `src/ios-argent.ts` and `websocket/ios/shim/argent-xcrun.js` in the Go SDK.

The CLI in `packages/cli` exists only here. A CLI-only change needs no Go counterpart, but the SDK
calls it uses do.
