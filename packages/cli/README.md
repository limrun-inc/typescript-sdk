# lim

The official command-line interface for [Limrun](https://limrun.com) — create and control cloud mobile sandboxes for Android, iOS, and Xcode.

## Installation

```bash
# npm
npm install -g lim

# npx (no install)
npx lim <command>
```

### Migrating from `@limrun/cli`

`lim` is the canonical npm package for the Limrun CLI. If you already installed the older scoped package, remove it before installing `lim` so npm does not hit a global `lim` binary conflict:

```bash
npm uninstall -g @limrun/cli
npm install -g lim
```

If you already have the `lim` package installed globally, update it with:

```bash
npm install -g lim
```

## Authentication

```bash
# Log in via browser (stores API key in ~/.lim/config.yaml)
lim login

# Or provide an API key directly
lim --api-key <YOUR_KEY> android list

# Or use an environment variable
export LIM_API_KEY=<YOUR_KEY>
lim android list

# Log out (removes stored API key)
lim logout
```

The CLI stores configuration in `~/.lim/config.yaml`. This file is compatible with the Go-based `lim` CLI — if you've already logged in with the Go version, the TypeScript CLI will use the same credentials.

## Fast First Run

```bash
lim run
```

`lim run` is the fastest way to get started with Limrun. Run it inside a clear iOS or Expo project root to install the Limrun agent skills for that project and get the next prompt for your coding agent. Run it anywhere else to clone the native sample app, build it on Limrun, and print a cloud simulator URL.

## Global Flags

Most commands support these flags (exceptions: `lim skills install` does not take `--api-key` because it does not talk to the API):

| Flag                | Description                                                |
| ------------------- | ---------------------------------------------------------- |
| `--api-key <value>` | API key (also reads `LIM_API_KEY` env var)                 |
| `--json`            | Output as JSON instead of human-readable tables            |
| `--quiet`           | Suppress intermediate logs and print only the final result |
| `--help`            | Show help for any command                                  |

## Command Structure

Commands are organized by resource (noun-first), so you can discover everything available for a platform with `--help`:

```bash
lim ios --help       # All iOS commands
lim android --help   # All Android commands
lim xcode --help     # All Xcode commands
lim asset --help     # All asset commands
```

**Instance ID is optional** on interaction commands. When omitted, the CLI uses the last created instance of the matching type:

```bash
lim ios create                  # Creates ios_abc123, remembers it
lim ios screenshot test.png     # Uses ios_abc123 automatically
lim ios tap 100 200             # Still uses ios_abc123
lim session start               # Starts session for ios_abc123
```

You can always provide an ID explicitly to target a specific instance:

```bash
lim ios screenshot test.png --id ios_def456
```

For repeatable scripts and LLM agents, prefer explicit platform commands plus an explicit `--id` once you have it:

```bash
lim ios get ios_abc123 --json
lim ios screenshot screenshot.png --id ios_abc123
lim android tap --id android_abc123 100 200
```

This avoids relying on locally cached "last created" state and keeps the target platform explicit.

## Commands

- [Run](#run) — Get started with Limrun on your project or the sample app
- [iOS](#ios) — Create, manage, and interact with iOS instances
- [Android](#android) — Create, manage, and interact with Android instances
- [Xcode](#xcode) — Create and manage Xcode sandbox instances
- [Assets](#assets) — Upload and download files (APKs, IPAs, etc.)
- [Sessions](#sessions) — Persistent connections for fast, interactive device control
- [Xcode Build Pipeline](#xcode-build-pipeline) — Sync code and run xcodebuild remotely
- [Skills](#skills) — Install Limrun skills for AI coding agents (Claude Code, Cursor, Codex)

---

### Run

`lim run` logs in if needed, then chooses the fastest useful path:

```bash
lim run
```

- In a clear native iOS project, it installs the Limrun iOS/Xcode skill into `.agents/skills/` and `.claude/skills/`.
- In a clear Expo project, it installs the Limrun iOS/Xcode and Expo skills into `.agents/skills/` and `.claude/skills/`.
- In any other directory, it clones `limrun-inc/sample-native-app`, builds it with a Limrun iOS simulator + Xcode sandbox, and prints a simulator URL.

After setup, open your coding agent in the project and ask it to build and run the app with Limrun. For manual agent setup, use `lim skills install`.

---

### iOS

```bash
lim ios create          # Create a new iOS instance
lim ios list            # List all ready iOS instances
lim ios get <ID>        # Get details of a specific instance
lim ios delete <ID>     # Delete an instance
lim ios info            # Get device info from a running instance
```

#### Create Options

```bash
# Basic
lim ios create

# With specific device model
lim ios create --model ipad --rm

# With pre-installed app from asset storage
lim ios create --install-asset my-app.ipa

# With Xcode sandbox enabled
lim ios create --xcode

# Lock the simulator to an app after it first enters the foreground
lim ios create --force-bundle-id com.example.myapp

# Full options
lim ios create --region us-west --display-name "CI Test" --label env=ci --rm
```

**Flags for `ios create`:**

| Flag                              | Description                                            |
| --------------------------------- | ------------------------------------------------------ |
| `--rm`                            | Auto-delete the instance on exit (Ctrl+C)              |
| `--model <iphone\|ipad\|watch>`   | Simulator device model                                 |
| `--xcode`                         | Attach a Xcode build sandbox to the iOS instance       |
| `--region <value>`                | Region for the instance (e.g. `us-west`)               |
| `--display-name <value>`          | Human-readable name                                    |
| `--label <key=value>`             | Labels (repeatable). Used for filtering and reuse      |
| `--hard-timeout <duration>`       | Max lifetime (e.g. `1m`, `10m`, `3h`). Default: none   |
| `--inactivity-timeout <duration>` | Idle timeout. Default: `3m`                            |
| `--force-bundle-id <bundle-id>`   | Lock to an app after it first enters the foreground    |
| `--reuse-if-exists`               | Reuse an existing instance with matching labels/region |
| `--install <file>`                | Local file to install (auto-uploads, repeatable)       |
| `--install-asset <name>`          | Asset name to install (repeatable)                     |

#### List and Filter

```bash
lim ios list                                   # Ready instances
lim ios list --all                             # All states
lim ios list --state creating                  # Filter by state
lim ios list --region us-west                  # Filter by region
lim ios list --label-selector env=prod         # Filter by labels
lim ios list --json                            # JSON output
lim ios get <ID>                               # Single instance details
```

#### Device Interaction

All interaction commands accept an optional `--id`. When omitted, the last created iOS instance is used.

```bash
# Device info
lim ios info
lim ios info --json

# Screenshots
lim ios screenshot screenshot.png

# Tapping
lim ios tap 100 200
lim ios tap-element --ax-label "Submit"
lim ios tap-element --ax-unique-id btn_ok

# Text input
lim ios type "Hello World"
lim ios type "search query" --enter
lim ios press-key enter
lim ios press-key a --modifier shift
lim ios toggle-keyboard

# Scrolling
lim ios scroll down --amount 500
lim ios scroll down --amount 500 --momentum 0.4

# Batch multiple actions in one call
lim ios perform --action type=tap,x=100,y=200 --action 'type=typeText,text=Hello World'
lim ios perform --action type=wait,durationMs=500 --action type=pressKey,key=enter
lim ios perform --file ./actions.yaml

# actions.yaml
- type: tap
  x: 100
  y: 200
- type: typeText
  text: "Hello World"

# UI inspection
lim ios element-tree
lim ios element-tree | jq '.'

# Open URLs / deep links
lim ios open-url https://example.com
lim ios open-url myapp://settings

# Low-level simulator access
lim ios simctl -- listapps booted
lim ios xcrun -- --sdk iphonesimulator --show-sdk-version
lim ios xcodebuild -- -version
lim ios cp payload.json ./fixtures/payload.json
lim ios lsof
```

#### App Management (iOS only)

```bash
# Install an app (local file auto-uploads, or use URL)
lim ios install-app ./MyApp.ipa
lim ios install-app https://example.com/app.ipa
lim ios install-app https://example.com/app.ipa --md5 <hex-digest>
lim ios install-app ./MyApp.ipa --launch-mode RelaunchIfRunning

# Launch — streams the app's logs until the app exits or Ctrl+C
lim ios launch-app com.example.myapp
lim ios launch-app com.example.myapp --mode RelaunchIfRunning

# Launch and exit immediately without streaming logs
lim ios launch-app com.example.myapp --detach

# Terminate
lim ios terminate-app com.example.myapp

# List installed apps
lim ios list-apps
```

#### Log Streaming (iOS only)

```bash
# Tail recent logs
lim ios app-log com.example.myapp --tail 50

# Stream logs continuously (Ctrl+C to stop)
lim ios app-log com.example.myapp --follow

# Stream full simulator syslog
lim ios syslog
lim ios syslog --json
```

#### Video Recording

```bash
lim ios record start
lim ios record start --quality 8
lim ios record stop
lim ios record stop -o recording.mp4
lim ios record stop --presigned-url https://example.com/upload
```

#### Built App Sync (iOS only)

```bash
# Sync a built .app bundle to the current iOS instance
lim ios sync ./Build/Products/Debug-iphonesimulator/MyApp.app

# Re-sync on changes and relaunch if the app is already running
lim ios sync ./MyApp.app --watch --launch-mode RelaunchIfRunning

# Use a custom delta-sync cache
lim ios sync ./MyApp.app --basis-cache-dir ./.limsync-cache
```

---

### Android

```bash
lim android create       # Create a new Android instance
lim android list         # List all ready Android instances
lim android get <ID>     # Get details of a specific instance
lim android delete <ID>  # Delete an instance
```

#### Create Options

```bash
# Basic (prints a Console URL you can open in the browser)
lim android create

# With apps pre-installed
lim android create --install ./my-app.apk --install ./another.apk

# Create without opening an ADB tunnel
lim android create --no-connect

# Full options
lim android create --region us-west --display-name "CI Test" --label env=ci --rm
```

**Android-specific flags:**

| Flag                | Description                                     |
| ------------------- | ----------------------------------------------- |
| `--[no-]connect`    | Start an ADB tunnel immediately (default: true) |
| `--adb-path <path>` | Path to `adb` binary (default: `adb`)           |

`lim android create` always prints a Console URL such as `https://console.limrun.com/stream/android_...` that you can open in the browser for live viewing. For automation, `--no-connect` is usually the safest default.

#### Device Interaction

All interaction commands accept an optional `--id`. When omitted, the last created Android instance is used.

```bash
# Screenshots
lim android screenshot screenshot.png

# Tapping
lim android tap 100 200
lim android tap-element --resource-id com.example:id/button
lim android tap-element --content-desc "Sign In button"
lim android tap-element --text "Sign In"
lim android find-element --resource-id com.example:id/button --json

# Text input
lim android type "Hello World"
lim android type "Hello World" --resource-id com.example:id/search_input
lim android press-key enter

# Scrolling
lim android scroll down --amount 500
lim android scroll down --resource-id com.example:id/list --amount 500

# UI inspection
lim android element-tree

# Install app
lim android install-app ./app.apk

# Open URL
lim android open-url https://example.com

# Wi-Fi bandwidth limits
lim android set-wifi-bandwidth --down-kbps 1000
lim android set-wifi-bandwidth --up-kbps 1000
lim android set-wifi-bandwidth --up-kbps 0

# Video recording
lim android record start
lim android record start --quality 8
lim android record stop
lim android record stop -o recording.mp4
lim android record stop --presigned-url https://example.com/upload
```

#### ADB Tunnel

Connect to a running Android instance for direct `adb` access:

```bash
lim android connect
lim android connect --id android_abc123 --adb-path /usr/local/bin/adb
```

The tunnel stays open until you press Ctrl+C. While connected, you can use `adb` commands in another terminal.

---

### Xcode

Standalone Xcode build sandboxes for remote compilation.

```bash
lim xcode create          # Create a new Xcode sandbox
lim xcode create --ios    # Create an iOS instance with an attached Xcode sandbox
lim xcode list            # List all ready Xcode instances
lim xcode get <ID>        # Get details of a specific instance
lim xcode delete <ID>     # Delete an instance
lim xcode attach-simulator <IOS_ID> --id <XCODE_ID>
```

```bash
# Create with options
lim xcode create --rm --region us-west --hard-timeout 1h

# Build (automatically syncs the project path first)
lim xcode build ./MyProject --scheme MyApp --workspace MyApp.xcworkspace

# Build and upload artifact
lim xcode build ./MyProject --scheme MyApp --upload my-app-build

# Build with app config values available as Xcode build settings
lim xcode build ./MyProject --scheme MyApp --build-setting 'SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) LIMRUN' --build-setting APP_CONFIG_DEV_LOGIN_SECRET="$DEV_LOGIN_SECRET"

# Signed device build
lim xcode build ./MyProject --scheme MyApp --certificate-p12 ./certificate.p12 --certificate-password "$P12_PASSWORD" --provisioning-profile ./profile.mobileprovision --upload signed-device-build.ipa

# Attach an existing simulator so builds auto-install there
lim xcode attach-simulator ios_abc123 --id sandbox_def456

# Tune sync cache or ignore additional paths
lim xcode sync ./MyProject --watch --basis-cache-dir ./.limsync-cache
lim xcode sync ./MyProject --ignore "\\.xcuserdata/" --ignore "^DerivedData/"
```

---

### Assets

Assets are files (APKs, IPAs, configs, etc.) stored in Limrun's cloud storage for use with instances.

```bash
# Upload a file
lim asset push ./my-app.apk
lim asset push ./my-app.ipa -n custom-name

# Download a file
lim asset pull asset_abc123
lim asset pull asset_abc123 -o ./downloads
lim asset list --name my-app.apk --json
lim asset pull asset_abc123

# List assets
lim asset list
lim asset list --name my-app
lim asset list --name-prefix builds/
lim asset list --download-url
lim asset list --include-app-store

# Get a specific asset
lim asset list asset_abc123

# Delete an asset
lim asset delete asset_abc123
```

---

### Sessions

Sessions keep a persistent WebSocket connection to an instance in the background, making all interaction commands near-instant (~50ms instead of ~2s per command).

#### Why Sessions?

Without a session, every command creates a new connection:

```
lim ios screenshot screenshot.png # ~2s (connect + auth + screenshot + disconnect)
lim ios tap 100 200             # ~2s (connect + auth + tap + disconnect)
lim ios element-tree            # ~2s (connect + auth + fetch + disconnect)
# Total: ~6s for 3 commands
```

With a session, the connection is created once and reused:

```
lim session start               # ~2s (one-time connection setup)
lim ios screenshot screenshot.png # ~50ms (reuses connection)
lim ios tap 100 200             # ~50ms (reuses connection)
lim ios element-tree            # ~50ms (reuses connection)
lim session stop                # instant cleanup
# Total: ~2.15s for 3 commands
```

This makes sessions essential for interactive workflows, AI agent loops, and any scenario where you run multiple commands against the same instance.

#### Session Commands

```bash
# Start a session (defaults to the last remembered iOS instance, otherwise Android, then Xcode)
lim session start

# Or specify an instance explicitly
lim session start --id ios_abc123

# Multiple sessions can run simultaneously
lim session start --id ios_abc123
lim session start --id android_def456

# Check all active sessions
lim session status
lim session status --json

# Stop a specific session
lim session stop --id ios_abc123

# Stop all sessions at once
lim session stop --all
```

If only one session is active, `lim session stop` (no ID) stops it automatically. For scripts and agents, prefer `--id` explicitly so the target instance is unambiguous.

#### How It Works

Each `lim session start` spawns an independent background daemon that:

- Holds a persistent WebSocket connection to that specific instance
- Listens on its own Unix socket under `~/.lim/sessions/<hashed-instance-id>/`
- All interaction commands automatically detect the matching session and route through it
- Multiple sessions run in parallel with no shared state

#### Example: Interactive Testing

```bash
lim ios create --model iphone
lim session start

# Fast interaction loop — each command takes ~50ms
lim ios launch-app com.example.myapp --detach
lim ios element-tree | jq '.tree'
lim ios tap-element --ax-label "Login"
lim ios type "user@example.com"
lim ios tap-element --ax-label "Submit"
lim ios screenshot after-login.png

lim session stop
lim ios delete ios_abc123
```

#### Example: Multi-Device AI Agent

```bash
# Create two instances and start sessions for both
lim ios create --model iphone
lim ios create --model ipad
lim session start --id ios_phone_123
lim session start --id ios_tablet_456

# Agent controls both devices in parallel — ~50ms per command
lim ios launch-app com.example.myapp --id ios_phone_123 --detach
lim ios launch-app com.example.myapp --id ios_tablet_456 --detach

lim ios screenshot phone.png --id ios_phone_123
lim ios screenshot tablet.png --id ios_tablet_456

lim ios tap 200 400 --id ios_phone_123
lim ios element-tree --id ios_tablet_456 --json > tablet-tree.json

# Clean up all sessions
lim session stop --all
lim ios delete ios_phone_123
lim ios delete ios_tablet_456
```

#### Example: Automated Test Matrix

```bash
# Spin up devices, start sessions, run tests, tear down
DEVICES=("iphone" "ipad")
IDS=()

for model in "${DEVICES[@]}"; do
  ID=$(lim ios create --model $model --json | jq -r '.metadata.id')
  lim session start --id $ID
  IDS+=($ID)
done

# Run tests against all devices
for ID in "${IDS[@]}"; do
  lim ios launch-app com.example.myapp --id $ID --detach
  lim ios screenshot "test_${ID}.png" --id $ID
done

# Tear down
lim session stop --all
for ID in "${IDS[@]}"; do
  lim ios delete $ID
done
```

---

### Xcode Build Pipeline

Build and test iOS apps remotely using cloud Xcode sandboxes. The `sync` and `build` commands work with both standalone Xcode instances and iOS instances that have Xcode sandbox enabled.

#### Option A: iOS Instance with Xcode Sandbox (Recommended)

This gives you a simulator **and** a build environment in one instance — the built app is automatically installed on the simulator.

```bash
# 1. Create iOS instance with Xcode sandbox
lim ios create --xcode
# Output:
#   Instance ID: ios_abc123
#   Xcode Sandbox: https://...limrun.net/v1/sandbox_.../xcode
#   (sandbox URL is cached locally for sync/build to use)

# 2. Build — automatically syncs your project code first, then auto-installs on the simulator
lim xcode build ./MyProject --id ios_abc123 --scheme MyApp --workspace MyApp.xcworkspace

# 3. Start a session for fast device interaction
lim session start

# 4. Test the built app on the simulator (~50ms per command)
lim ios launch-app com.example.myapp --detach
lim ios element-tree | jq '.'
lim ios screenshot built-app.png

# 5. Clean up
lim session stop
lim ios delete ios_abc123
```

> **Note:** `lim xcode build` already syncs the project path you pass before invoking `xcodebuild`, so you do not need to call `lim xcode sync` first. The Xcode sandbox URL is only returned when the instance is created — not on subsequent `list` calls. The CLI caches it locally at `~/.lim/instances/` so that build workflows can find it. This means `build` must run on the same machine where `ios create --xcode` was executed.

#### Option B: Standalone Xcode Instance

Use this when you only need to build (no simulator needed), or when you want to attach a simulator separately.

```bash
# 1. Create a standalone Xcode instance
lim xcode create --rm

# 2. Optionally attach an existing simulator by ID
lim xcode attach-simulator ios_abc123 --id sandbox_def456

# 3. Build (automatically syncs the project path first)
lim xcode build ./MyProject --scheme MyApp --workspace MyApp.xcworkspace

# 4. Upload build artifact
lim xcode build ./MyProject --scheme MyApp --upload my-app-build

# Signed device builds default to --sdk iphoneos when signing assets are provided
lim xcode build ./MyProject --scheme MyApp --certificate-p12 ./certificate.p12 --certificate-password "$P12_PASSWORD" --provisioning-profile ./profile.mobileprovision --upload signed-device-build.ipa

# 5. Download the artifact
lim asset pull my-app-build -o ./build-output
```

#### Build Behavior

`lim xcode build [PATH]` automatically performs a one-shot code sync for the given project path before invoking `xcodebuild`. The sync step automatically ignores build artifacts (`build/`, `DerivedData/`, `.build/`), dependency folders (`Pods/`, `Carthage/Build/`, `.swiftpm/`), and user-specific files (`xcuserdata/`, `.dSYM/`).

For [XcodeGen](https://github.com/yonaskolb/XcodeGen) projects whose generated `.xcodeproj` is gitignored, the server generates it from your synced `project.yml` automatically before the build — it looks next to a pinned `--project`/`--workspace` path, at the synced folder root, and one directory level down. If your spec has a different name or location, pin it with `--xcodegen-spec <path>`, optionally control the output directory with `--xcodegen-project <dir>`, and anchor relative paths in the spec with `--xcodegen-project-root <dir>`; all paths are relative to the synced folder root and mirror `xcodegen generate --spec/--project/--project-root`. Passing any of these flags always regenerates the project on the server:

```bash
lim xcode build ./MyProject --xcodegen-spec specs/app.yml --xcodegen-project ios
```

Pass `--build-setting KEY=VALUE` to set Xcode build settings on the build. Allowed keys are a server-maintained allowlist of safe settings (currently `SWIFT_ACTIVE_COMPILATION_CONDITIONS`) plus any `APP_CONFIG_*` key for app configuration. Keys are passed to xcodebuild verbatim; use `$(inherited)` to append rather than replace, e.g. `--build-setting 'SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) LIMRUN'` (single-quote it so your shell does not evaluate `$(inherited)`) enables `#if LIMRUN`. An `APP_CONFIG_DEV_LOGIN_SECRET` value is referenced in `Info.plist` as `<string>$(APP_CONFIG_DEV_LOGIN_SECRET)</string>` and read at runtime with `Bundle.main`; its value is redacted in build logs.

Provide `--certificate-p12`, `--certificate-password`, and `--provisioning-profile` together to sign a real-device build. When signing assets are provided without `--sdk`, the CLI builds with `iphoneos`; pass `--sdk watchos` for signed watchOS device builds.

---

### Skills

Fetch the latest Limrun skills from `limrun-inc/skills@main` and install them into the native skills directory of AI coding agents (Claude Code, Cursor, Codex). After installation, the agent auto-discovers the skill and triggers it when you ask things like "build the iOS app" or "show me a screenshot."

```bash
# Interactive: prompts for agents (with detected ones pre-checked) and scope
lim skills install

# Non-interactive
lim skills install --agents claude --scope project
lim skills install --agents claude --agents cursor --scope project
lim skills install --agents codex --scope global
lim skills install --agents cursor --scope project --skills limrun-expo-development

# Overwrite existing skill directories (otherwise the command refuses on non-interactive runs)
lim skills install --agents claude --scope project --force

# Machine-readable output for scripts
lim skills install --agents claude --scope project --json
```

**Flags:**

| Flag                        | Description                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `--agents <id>`             | Target agent. Repeat to select multiple. One of: `claude`, `cursor`, `codex`.                |
| `--skills <name>`           | Limrun skill to install. Repeat to select multiple. Defaults to the remote catalog default.  |
| `--scope <project\|global>` | `project` writes into the current directory; `global` writes into the user's home directory. |
| `--force`                   | Overwrite existing skill directories without confirmation.                                   |
| `--json`                    | Emit structured JSON instead of the human summary.                                           |
| `--quiet`                   | Suppress non-result output.                                                                  |

**Available skills:**

- `limrun-xcode-and-ios-simulator` (default): Build, launch, and control iOS apps with remote XCode and Simulators.
- `limrun-expo-development`: Iterate on Expo / React Native apps with remote iOS dev-client workflows.
- `limrun-detox-testing`: Configure, run, and debug Detox against Limrun iOS simulators.

**Install paths:**

| Agent       | Project                   | Global                                                                     |
| ----------- | ------------------------- | -------------------------------------------------------------------------- |
| Claude Code | `.claude/skills/<skill>/` | `$CLAUDE_CONFIG_DIR/skills/<skill>/` (default `~/.claude/skills/<skill>/`) |
| Cursor      | `.agents/skills/<skill>/` | `~/.agents/skills/<skill>/`                                                |
| Codex       | `.codex/skills/<skill>/`  | `$CODEX_HOME/skills/<skill>/` (default `~/.codex/skills/<skill>/`)         |

**Behavior:**

- The command fetches `limrun-inc/skills@main` at runtime, so skill updates do not require a new `lim` release.
- The command compares fetched vs existing skill directories byte-for-byte. Identical content is reported as `Unchanged` (no writes).
- Different content: in interactive mode you are asked to confirm each overwrite; in non-interactive mode the command refuses unless `--force` is passed.
- Non-interactive runs are all-or-nothing: if any selected target conflicts and `--force` is not set, no files are written for any target, and the command exits with status 1.
- Ctrl-C cancellation at any prompt exits cleanly without writing.

Cursor reads `.agents/skills/` natively, so we install there rather than `.cursor/skills/`. As a bonus, the same install reaches OpenCode and any other tool that follows the AGENTS.md convention - no extra menu options needed.

---

## Configuration

The CLI reads configuration from multiple sources (in order of precedence):

1. Command-line flags (`--api-key`)
2. Environment variables (`LIM_API_KEY`, `LIM_API_ENDPOINT`, `LIM_CONSOLE_ENDPOINT`), including values loaded from a local `.env` file
3. Config file (`~/.lim/config.yaml`)

**Config file keys:**

| Key                | Default                      | Description             |
| ------------------ | ---------------------------- | ----------------------- |
| `api-key`          | —                            | Your Limrun API key     |
| `api-endpoint`     | `https://api.limrun.com`     | API base URL            |
| `console-endpoint` | `https://console.limrun.com` | Console URL (for login) |

---

## JSON Output

All commands support `--json` for machine-readable output, making the CLI suitable for scripting and AI agent automation:

```bash
# Get instance details as JSON
lim ios get ios_abc123 --json

# Parse with jq
lim android list --json | jq '.[].metadata.id'

# Use in scripts
INSTANCE_ID=$(lim ios create --json | jq -r '.metadata.id')
lim ios screenshot test.png --id $INSTANCE_ID
lim ios delete $INSTANCE_ID
```

---

## Workflows

### CI Testing: Install and Verify an App

```bash
# Create instance and start session for fast commands
lim ios create --install ./build/MyApp.ipa
lim session start

# Verify — each command takes ~50ms with session
lim ios launch-app com.example.myapp --detach
sleep 2
lim ios element-tree | grep "Welcome"
lim ios screenshot test-result.png

# Clean up
lim session stop
lim ios delete ios_abc123
```

### AI Agent Automation

```bash
# Create instance
INSTANCE=$(lim ios create --model iphone --json)
ID=$(echo $INSTANCE | jq -r '.metadata.id')

# Start session — all commands now run in ~50ms
lim session start

# Agent can interact at high speed
lim ios tap 200 400
lim ios type "test@example.com"
lim ios tap-element --ax-label "Sign In"
lim ios screenshot result.png
lim ios element-tree --json > ui-state.json

# Tail logs (non-streaming works through session too)
lim ios app-log com.example.myapp --tail 20

# Clean up
lim session stop
lim ios delete $ID
```

### Remote Build + Test on iOS Simulator

```bash
# Single instance: Xcode sandbox + iOS simulator
ID=$(lim ios create --xcode --json | jq -r '.metadata.id')

# Build and test (build automatically syncs the project path first)
lim xcode build ./MyiOSProject --id $ID --scheme MyApp --workspace MyApp.xcworkspace

# Verify the built app on the simulator
lim session start
lim ios launch-app com.example.myapp --detach
sleep 2
lim ios element-tree | grep "Welcome"
lim ios screenshot test-result.png
lim session stop

lim ios delete $ID
```

### Build-Only with Artifact Upload

```bash
lim xcode create --rm --reuse-if-exists --label project=myapp

lim xcode build ./MyiOSProject --scheme MyApp --workspace MyApp.xcworkspace --upload myapp-latest
lim asset list --name myapp-latest --json
lim asset pull asset_abc123 -o ./build-output
```

---

## Development

### Setup

```bash
cd packages/cli
npm ci
npm run build
```

This package is managed with npm (CI runs `npm ci` against `packages/cli/package-lock.json`),
even though the root SDK and `packages/ui` use yarn. Use npm here, not yarn, so you do not create a
stray `yarn.lock`. The CLI's `build` still shells out to yarn to build the root SDK first, so keep
yarn installed.

### Run commands during development

```bash
# After making changes, rebuild and run
npm run build && node bin/run.js <command>

# Or use watch mode in one terminal, run in another
npx tsc --watch            # Terminal 1
node bin/run.js ios list   # Terminal 2
```

### Link globally

```bash
npm link

# Now `lim` works anywhere on your machine
lim --help
lim android list

# Unlink when done
npm unlink -g lim
```

### End-to-end testing with local SDK changes (`limx`)

Most CLI changes also touch the SDK (`@limrun/api`). `npm link` only links the CLI, so it
keeps running the published SDK from the registry. The `limx-from` helper builds both the SDK
and the CLI from a checkout, links the locally built SDK into the CLI, and installs a separate
`limx` binary that runs that build, so it never clashes with a real `lim` on your PATH.

```bash
# From the repo root (first run also installs the global `limx-from`)
./hack/limx-from

# limx now runs the local SDK + CLI build
limx ios list
limx --where          # prints which checkout limx points at

# Point limx at another worktree (builds + relinks it)
limx-from /path/to/other-worktree

# Stop using limx
limx-from --unlink
```

Iterating after the initial link:

- SDK change: `yarn build` (the link tracks `dist/`, no relink needed)
- CLI change: `yarn --cwd packages/cli build`

Note: any `yarn install` inside `packages/cli` restores the published copy of `@limrun/api`.
Re-run `limx-from` to re-link the local build. `limx --where` always tells you the current
state. (`limx --version` and `--help` still self-identify as `lim`; that's expected.)
