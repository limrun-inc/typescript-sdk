# CLI JSON contract

Use `--json` for automation on commands whose help lists that flag. JSON output is a public CLI interface. Preserve existing field names, types, and meanings when changing a command. Additive fields are allowed; consumers should ignore fields they do not use. Removing or renaming a field requires a documented compatibility change.

## Transport and exit status

- Non-streaming commands write one JSON value to stdout. List commands return arrays, including `[]` for no results. Resource commands retain their API/SDK response fields, rather than rendering table cells as strings.
- Log streams, foreground builds and app launches, `sync --watch`, `tunnel run`, and `xcode test` write newline-delimited JSON. Each line is a complete JSON value. Newlines inside strings are escaped.
- Commands that hold a connection, such as `android connect`, device tunnels, reverse tunnels, and RBE, write their readiness result and stay running. Creation with `--rm` also stays running after its instance response. JSON changes output, not lifecycle.
- Human messages and SDK diagnostics never go to stdout in JSON mode. Diagnostics may appear on stderr. `--quiet --json` has the same JSON result as `--json`.
- Check the process exit status. Nonzero means failure. Execution commands can return a structured result with a nonzero `exitCode` or `code`; receiving JSON alone does not mean success. A failed mutation does not emit a success acknowledgement.
- CLI, validation, and API errors emit `{"error":{"code":"CLI_ERROR","message":"..."}}` on stderr. A specific error code replaces `CLI_ERROR` when available; HTTP errors also include numeric `status`. stderr may also contain diagnostics, so do not parse the whole stream as one JSON document. Explicit process exits after an execution result preserve the exit status without adding another result.
- Pass the CLI's `--json` before `--`. Flags after `--` belong to the invoked tool. Interactive commands that do not advertise JSON, including the onboarding `run`, reject it.

## Login

| Commands | JSON result                                                                                                                                                                                                                                                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login`  | Newline-delimited JSON. First `{status:"pending", verificationUrl, phrase, expiresAt}` as soon as the login starts, then `{status:"signed-in"}` after approval. The command waits until approval or `expiresAt`. The session secret is stored in `~/.lim/pending-login.json` and never printed; running `login` again before `expiresAt` continues the same session and prints the same URL and phrase. |
| `whoami` | `{signedIn:true, type?, organizationId?, organizationName?, email?}` or `{signedIn:false, pendingLogin?:{verificationUrl, phrase, expiresAt}}`. Exit 0 in both cases. The API key is never printed.                                                                                                                                                                                                     |

## Instance and asset resources

| Commands                                                        | JSON result                                                                                                                               |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `android create`, `ios create`, `xcode create`, `gradle create` | The created instance resource, including `metadata`, `spec`, and `status`. Existing attachment fields on iOS/Xcode creation are retained. |
| `android get`, `ios get`, `gradle get`                          | The instance resource. With no explicit or remembered instance, the existing fallback returns the corresponding list.                     |
| `xcode get`                                                     | The existing resolved Xcode target fields plus `simulator` status.                                                                        |
| Instance `list` commands                                        | Array of instance resources.                                                                                                              |
| Instance `delete`, `asset delete`, `tunnel delete`              | `{"ok":true,"id":"..."}`. The ID identifies the resource deleted. Instance deletion remains idempotent for an already-missing instance.   |
| `asset push`                                                    | The uploaded asset resource, including `id`, `name`, and any API-provided expiry and URLs.                                                |
| `asset list`                                                    | Array of asset resources.                                                                                                                 |
| `asset pull`                                                    | `{"localPath":"/absolute/path","bytes":123}`.                                                                                             |

`assets` aliases use the same contract as `asset`.

Android creation returns the same instance resource with or without `--connect`. The default still starts a background ADB tunnel. `--no-connect` skips it; JSON mode already suppresses browser opening. Foreground connection modes return the resource after starting the tunnel, before waiting for shutdown.

```sh
lim android create --hard-timeout=10m --json > instance.json
jq -r '.metadata.id' instance.json

# Create without starting a local ADB tunnel.
lim android create --hard-timeout=10m --no-connect --json > instance.json
lim android connect --id "$(jq -r '.metadata.id' instance.json)"

lim asset push ./app.apk --json | jq -r .id
```

Instance responses include access credentials. Store them with the same care as API responses.

## Device actions and files

Existing JSON-enabled device commands keep their existing response shapes. In particular, element trees, selectors, device info, app lists, microphone operations, proxy operations, and file operations retain their API/SDK fields.

| Commands                          | JSON result                                                                                                                                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iOS/Android `tap`                 | `{ok:true, instanceId, x, y}`; iOS adds `display` when explicitly selected.                                                                                                                              |
| iOS/Android `type`                | `{ok:true, instanceId, textLength}`; iOS adds `enter` and `requireFocus`, Android adds `target` when selected. `textLength` counts UTF-16 code units; input text is not echoed.                          |
| iOS/Android `press-key`           | `{ok:true, instanceId, key, modifiers}`. `modifiers` is an array, empty when none were requested.                                                                                                        |
| iOS/Android `scroll`              | `{ok:true, instanceId, direction, amount}`; iOS adds requested `momentum`, `coordinate: [x,y]`, and `display`. Android adds `target` when selected.                                                      |
| iOS/Android `open-url`            | `{ok:true, instanceId, url}`.                                                                                                                                                                            |
| iOS/Android `terminate-app`       | `{ok:true, instanceId, bundleId}` on iOS; `packageName` on Android.                                                                                                                                      |
| Detached iOS/Android `launch-app` | `{ok:true, instanceId, bundleId, mode}` on iOS; `packageName` on Android. `mode` is the effective launch mode, including defaults. iOS adds `runtime` when requested. Environment values are not echoed. |
| iOS `swipe`                       | `{ok:true, instanceId, from:[x,y], to:[x,y], durationMs}`; adds `display` when explicitly selected.                                                                                                      |
| iOS `toggle-keyboard`             | `{ok:true, instanceId}`. The API does not report the resulting keyboard visibility.                                                                                                                      |
| Android `install-app`             | `{ok:true, instanceId, source}`. `source` is the supplied path or URL; local uploads also include `assetId`. Acknowledges sending the asset to the instance.                                             |
| `ios install-app`                 | Existing installation result, including the bundle ID when supplied by the SDK.                                                                                                                          |
| `android set-wifi-bandwidth`      | `{ok:true, instanceId, downKbps:0, upKbps:1000}`. Only requested directions are included; zero clears that limit.                                                                                        |
| iOS/Android `record start`        | `{ok:true, instanceId, recording:true, quality, persist}`. Explicit retention adds `persistTtlSeconds`. iOS adds `touchIndicators` and, when requested, `display`.                                       |
| iOS/Android `record stop`         | `{ok:true, instanceId, recording:false, localPath, uploaded}`. `uploaded` is true after a requested presigned upload completes.                                                                          |
| `ios keychain generate-key`       | `{"key":"base64-encoded-key"}`.                                                                                                                                                                          |
| `android connect`                 | `{"instanceId":"...","address":{"address":"127.0.0.1","port":12345}}` from the local tunnel. The command stays running.                                                                                  |

Camera `play` on both platforms returns `{ok:true, instanceId, action:"play", localPath, loop}`. Camera `clear` returns `{ok:true, instanceId, action:"clear"}`. Existing `ok` and `loop` fields are retained.

These action results identify the resolved instance, including when the CLI selected a remembered instance. Parameters describe the submitted action after it succeeds, not a separate observation of device state. Optional targeting fields are omitted when no override was supplied. Android `target` uses the SDK shape: `{x,y}` or `{selector:{resourceId, text, ...}}`.

Direct WebSocket connections and background session connections have the same command output contract.

## Builds, execution, sync, and logs

| Commands                                                                       | JSON result                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Foreground `xcode build`, `gradle build`                                       | NDJSON `{type:"stdout",line}` and `{type:"stderr",line}` events, followed by `{type:"result",instanceId,...SDK execution result}`. The result retains `execId`, `status`, `exitCode`, artifact/store fields, `timedOut`, and `incomplete`. |
| `xcode build --detach`, `gradle build --detach`                                | Existing `instanceId`, `execId`, `consoleUrl`, `logsCommand`, and optional `webhookUrl`. Acceptance does not mean completion.                                                                                                              |
| Xcode/Gradle `run`, `tools`, `tools install`, mise `use`                       | SDK execution result plus captured `stdout` and `stderr` strings. Mixed `xcode use xcode@... node@...` adds the Xcode selection under `xcode`. Xcode-only selection keeps its existing selection response.                                 |
| iOS `simctl`, `xcrun`, `xcodebuild`, `defaults`, `notify`; Android `adb-shell` | Existing tool execution response, with stdout, stderr, and the tool's `code` or `exitCode`.                                                                                                                                                |
| `ios maestro`                                                                  | `{"exitCode":0}`; Maestro output goes to stderr.                                                                                                                                                                                           |
| iOS/Android/Xcode/Gradle `sync`                                                | SDK sync result, such as `bytesSent`, and optional installed app fields. No watcher function is serialized.                                                                                                                                |
| `sync --watch`                                                                 | One SDK sync event per line, including `bytesSent`, `durationMs`, and optional installed app fields, for the initial sync and each update.                                                                                                 |
| Android `app-log` without `--follow`                                           | Shell result containing `stdout`, `stderr`, and `exitCode`.                                                                                                                                                                                |
| iOS `app-log` without `--follow`                                               | `{"stdout":"..."}`.                                                                                                                                                                                                                        |
| Android `app-log --follow`                                                     | One API app-log capture record per line.                                                                                                                                                                                                   |
| iOS `app-log --follow`, Android `logcat`, iOS `syslog`                         | One `{"line":"..."}` record per line.                                                                                                                                                                                                      |
| Foreground iOS/Android `launch-app`                                            | The detached launch fields with `type:"launched"` instead of `ok`; iOS log events use `{type:"log",line}`. Exit events use `type:"exit"` and the SDK app-exit fields; Android includes its log tail in `logs`.                             |
| `xcode test`                                                                   | Existing XCTest event records followed by the existing terminal `{exitCode, timedOut?, incomplete?}` record.                                                                                                                               |
| Xcode/Gradle `logs`                                                            | Existing collected execution-log response.                                                                                                                                                                                                 |

Foreground build output events preserve the order received from the SDK and identify the original stream. Lines are not buffered until the build ends. Empty lines remain empty strings, and embedded newlines are escaped. Once execution returns, exactly one `result` event ends the stream, including for failed and timed-out executions. A CLI/API failure before an execution result is available emits an error on stderr instead. `--detach` retains its single acknowledgement object.

A `timedOut` execution result means the client stopped waiting. The remote execution may still be running. Inspect `incomplete` and follow its logs instead of assuming that retrying is harmless.

```sh
lim gradle build . --json > build.ndjson 2> diagnostics.log
jq 'select(.type == "result")' build.ndjson
jq -r 'select(.type == "stdout" or .type == "stderr") | .line' build.ndjson
lim ios syslog --json | jq --unbuffered -r .line
lim xcode sync . --watch --json | jq --unbuffered .bytesSent
```

## Sessions and tunnels

| Commands                                                                  | JSON result                                                                                                                                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session start`                                                           | `{"instanceId":"...","running":true,"alreadyRunning":false}`.                                                                                     |
| `session stop`                                                            | `{"stopped":["instance-id"]}`. Empty if nothing was running; `--all` produces one array, not one response per session. Ambiguous selection fails. |
| `session status`                                                          | Existing array of session status objects.                                                                                                         |
| Device tunnel start/status/stop, `ios reverse`                            | Existing readiness/status/stop responses.                                                                                                         |
| `tunnel run`                                                              | One SDK connector event per line.                                                                                                                 |
| Private tunnel create/list/update/rotate                                  | Existing API tunnel responses and token fields.                                                                                                   |
| `xcode rbe`                                                               | Existing readiness result. An already-running tunnel returns its stored process fields plus `running: true`.                                      |
| `xcode rbe --stop`                                                        | `{"stopped":false}` if none is running; otherwise `{stopped:true, forced, instanceId, pid}`.                                                      |
| `xcode rbe upload`, version selection, set-instance, and `skills install` | Existing structured results are unchanged.                                                                                                        |

## Maintaining the contract

Changes must keep JSON stdout free of human text on success, failure, empty results, daemon and direct connections, and foreground and detached paths. Use `outputJson` for finite results, `outputEvent` for streams, and `outputResult` for data with a human-readable alternative. Do not use plain logging or inherited child stdout for JSON results. Configure SDK clients so their informational logging cannot reach stdout.

The CLI tests exercise response shapes, stream framing, both device transports, default Android creation, foreground and detached behavior, failures, and the executable's error handling. Add a contract test when adding a new JSON branch or changing a response.
