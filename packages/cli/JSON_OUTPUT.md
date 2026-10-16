# CLI JSON contract

Use `--json` for automation on commands whose help lists that flag. JSON output is a public CLI interface. Preserve existing field names, types, and meanings when changing a command. Additive fields are allowed; consumers should ignore fields they do not use. Removing or renaming a field requires a documented compatibility change.

## Transport and exit status

- Finite commands write one JSON value to stdout. List commands return arrays, including `[]` for no results. Resource commands retain their API/SDK response fields, rather than rendering table cells as strings.
- Log streams, foreground app launches, `sync --watch`, `tunnel run`, and `xcode test` write newline-delimited JSON. Each line is a complete JSON value. Newlines inside strings are escaped.
- Commands that hold a connection, such as `android connect`, device tunnels, reverse tunnels, and RBE, write their readiness result and stay running. Creation with `--rm` also stays running after its instance response. JSON changes output, not lifecycle.
- Human messages, SDK diagnostics, and foreground build output never go to stdout in JSON mode. Diagnostics may appear on stderr. `--quiet --json` has the same JSON result as `--json`.
- Check the process exit status. Nonzero means failure. Execution commands can return a structured result with a nonzero `exitCode` or `code`; receiving JSON alone does not mean success. A failed mutation does not emit a success acknowledgement.
- CLI, validation, and API errors emit `{"error":{"code":"CLI_ERROR","message":"..."}}` on stderr. A specific error code replaces `CLI_ERROR` when available; HTTP errors also include numeric `status`. stderr may also contain diagnostics, so do not parse the whole stream as one JSON document. Explicit process exits after an execution result preserve the exit status without adding another result.
- Pass the CLI's `--json` before `--`. Flags after `--` belong to the invoked tool. Interactive commands that do not advertise JSON, including `login` and the onboarding `run`, reject it.

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

Existing JSON-enabled device commands keep their existing response shapes. In particular, element trees, selectors, device info, app lists, camera/microphone operations, proxy operations, and file operations retain their API/SDK fields.

| Commands                                                                                                                                                                | JSON result                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| iOS/Android `tap`, `type`, `press-key`, `scroll`, `open-url`, `terminate-app`; iOS `swipe`, `toggle-keyboard`; Android `install-app`; detached iOS/Android `launch-app` | `{"ok":true}` after the action completes.                                                                                                            |
| `ios install-app`                                                                                                                                                       | Existing installation result, including the bundle ID when supplied by the SDK.                                                                      |
| `android set-wifi-bandwidth`                                                                                                                                            | `{"ok":true,"downKbps":0,"upKbps":1000}`. Only requested directions are included; zero clears that limit.                                            |
| iOS/Android `record start`                                                                                                                                              | `{"ok":true,"recording":true,"persist":false}`. `persist` reflects whether persistence was requested.                                                |
| iOS/Android `record stop`                                                                                                                                               | `{"ok":true,"recording":false,"localPath":"/absolute/video.mp4","uploaded":false}`. `uploaded` is true after a requested presigned upload completes. |
| `ios keychain generate-key`                                                                                                                                             | `{"key":"base64-encoded-key"}`.                                                                                                                      |
| `android connect`                                                                                                                                                       | `{"instanceId":"...","address":{"address":"127.0.0.1","port":12345}}` from the local tunnel. The command stays running.                              |

Direct WebSocket connections and background session connections have the same command output contract.

## Builds, execution, sync, and logs

| Commands                                                                       | JSON result                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foreground `xcode build`, `gradle build`                                       | SDK execution result plus `instanceId`: `execId`, `status`, `exitCode`, and optional fields such as `signedDownloadUrl`, `appstore`, `playstore`, `timedOut`, and `incomplete`. Build logs go to stderr.                          |
| `xcode build --detach`, `gradle build --detach`                                | Existing `instanceId`, `execId`, `consoleUrl`, `logsCommand`, and optional `webhookUrl`. Acceptance does not mean completion.                                                                                                     |
| Xcode/Gradle `run`, `tools`, `tools install`, mise `use`                       | SDK execution result plus captured `stdout` and `stderr` strings. Mixed `xcode use xcode@... node@...` adds the Xcode selection under `xcode`. Xcode-only selection keeps its existing selection response.                        |
| iOS `simctl`, `xcrun`, `xcodebuild`, `defaults`, `notify`; Android `adb-shell` | Existing tool execution response, with stdout, stderr, and the tool's `code` or `exitCode`.                                                                                                                                       |
| `ios maestro`                                                                  | `{"exitCode":0}`; Maestro output goes to stderr.                                                                                                                                                                                  |
| iOS/Android/Xcode/Gradle `sync`                                                | SDK sync result, such as `bytesSent`, and optional installed app fields. No watcher function is serialized.                                                                                                                       |
| `sync --watch`                                                                 | One SDK sync event per line, including `bytesSent`, `durationMs`, and optional installed app fields, for the initial sync and each update.                                                                                        |
| Android `app-log` without `--follow`                                           | Shell result containing `stdout`, `stderr`, and `exitCode`.                                                                                                                                                                       |
| iOS `app-log` without `--follow`                                               | `{"stdout":"..."}`.                                                                                                                                                                                                               |
| Android `app-log --follow`                                                     | One API app-log capture record per line.                                                                                                                                                                                          |
| iOS `app-log --follow`, Android `logcat`, iOS `syslog`                         | One `{"line":"..."}` record per line.                                                                                                                                                                                             |
| Foreground iOS/Android `launch-app`                                            | `{"type":"launched","bundleId":"..."}` on iOS or `packageName` on Android; iOS log events use `{"type":"log","line":"..."}`. Exit events use `type: "exit"` and the SDK app-exit fields; Android includes its log tail in `logs`. |
| `xcode test`                                                                   | Existing XCTest event records followed by the existing terminal `{exitCode, timedOut?, incomplete?}` record.                                                                                                                      |
| Xcode/Gradle `logs`                                                            | Existing collected execution-log response.                                                                                                                                                                                        |

A `timedOut` execution result means the client stopped waiting. The remote execution may still be running. Inspect `incomplete` and follow its logs instead of assuming that retrying is harmless.

```sh
lim gradle build . --json > build.json 2> build.log
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
