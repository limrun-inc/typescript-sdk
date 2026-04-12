# @limrun/cli

The official command-line interface for [Limrun](https://limrun.com) — create and control cloud mobile sandboxes for Android, iOS, and Xcode.

## Installation

```bash
# npm
npm install -g @limrun/cli

# npx (no install)
npx @limrun/cli <command>
```

## Authentication

```bash
# Log in via browser (stores API key in ~/.lim/config.yaml)
lim login

# Or provide an API key directly
lim --api-key <YOUR_KEY> get android

# Or use an environment variable
export LIM_API_KEY=<YOUR_KEY>
lim get android

# Log out (removes stored API key)
lim logout
```

The CLI stores configuration in `~/.lim/config.yaml`. This file is compatible with the Go-based `lim` CLI — if you've already logged in with the Go version, the TypeScript CLI will use the same credentials.

## Global Flags

Every command supports these flags:

| Flag | Description |
|------|-------------|
| `--api-key <value>` | API key (also reads `LIM_API_KEY` env var) |
| `--json` | Output as JSON instead of human-readable tables |
| `--help` | Show help for any command |

## Commands

- [Instance Management](#instance-management) — Create, list, and delete Android/iOS/Xcode instances
- [Asset Management](#asset-management) — Upload and download files (APKs, IPAs, etc.)
- [Sessions](#sessions) — Persistent connections for fast, interactive device control
- [Device Interaction](#device-interaction) — Screenshots, tapping, typing, scrolling, and more
- [Xcode Build Pipeline](#xcode-build-pipeline) — Sync code and run xcodebuild remotely
- [Connectivity](#connectivity) — ADB tunnel for Android debugging

---

### Instance Management

#### Create Instances

```bash
# Android instance with ADB tunnel and scrcpy streaming
lim run android

# Android with apps pre-installed
lim run android --install ./my-app.apk --install ./another.apk

# Android with custom settings
lim run android --region us-west --display-name "CI Test" --label env=ci --rm

# iOS instance
lim run ios

# iOS with specific device model
lim run ios --model ipad --rm

# iOS with pre-installed app from asset storage
lim run ios --install-asset my-app.ipa

# Xcode build sandbox
lim run xcode --rm --hard-timeout 1h
```

**Common flags for `run` commands:**

| Flag | Description |
|------|-------------|
| `--rm` | Auto-delete the instance on exit (Ctrl+C) |
| `--region <value>` | Region for the instance (e.g. `us-west`) |
| `--display-name <value>` | Human-readable name |
| `--label <key=value>` | Labels (repeatable). Used for filtering and reuse |
| `--hard-timeout <duration>` | Max lifetime (e.g. `1m`, `10m`, `3h`). Default: none |
| `--inactivity-timeout <duration>` | Idle timeout. Default: `3m` |
| `--reuse-if-exists` | Reuse an existing instance with matching labels/region |
| `--install <file>` | Local file to install (auto-uploads, repeatable) |
| `--install-asset <name>` | Asset name to install (repeatable) |

**Android-specific flags:**

| Flag | Description |
|------|-------------|
| `--[no-]connect` | Start ADB tunnel (default: true) |
| `--[no-]stream` | Launch scrcpy for visual control (default: true) |
| `--adb-path <path>` | Path to `adb` binary (default: `adb`) |

**iOS-specific flags:**

| Flag | Description |
|------|-------------|
| `--model <iphone\|ipad\|watch>` | Simulator device model |
| `--xcode` | Attach a Xcode build sandbox to the iOS instance |

#### List Instances

```bash
# List ready instances
lim get android
lim get ios
lim get xcode

# Get a specific instance by ID
lim get android android_abc123

# Show all states (not just ready)
lim get ios --all

# Filter by state, region, or labels
lim get android --state creating
lim get ios --region us-west
lim get android --label-selector env=prod,team=mobile

# JSON output for scripting
lim get android --json
```

**Filtering flags:**

| Flag | Description |
|------|-------------|
| `--all` | Show instances in all states |
| `--state <value>` | Filter by state (`unknown`, `creating`, `ready`, `terminated`) |
| `--region <value>` | Filter by region |
| `--label-selector <value>` | Filter by labels (e.g. `env=prod,team=mobile`) |

#### Delete Instances

```bash
# Delete by type
lim delete android android_abc123
lim delete ios ios_abc123
lim delete xcode xcode_abc123

# Auto-detect type from ID prefix
lim delete android_abc123
lim delete ios_abc123
```

---

### Asset Management

Assets are files (APKs, IPAs, configs, etc.) stored in Limrun's cloud storage for use with instances.

```bash
# Upload a file
lim push ./my-app.apk
lim push ./my-app.ipa -n custom-name

# Download a file
lim pull asset_abc123
lim pull my-app.apk
lim pull asset_abc123 -o ./downloads

# List assets
lim get asset
lim get asset --name my-app
lim get asset --download-url

# Get a specific asset
lim get asset asset_abc123

# Delete an asset
lim delete asset asset_abc123
```

---

### Sessions

Sessions keep a persistent WebSocket connection to an instance in the background, making all `exec` commands near-instant (~50ms instead of ~2s per command).

#### Why Sessions?

Without a session, every `exec` command creates a new connection:

```
lim exec screenshot ios_abc123      # ~2s (connect + auth + screenshot + disconnect)
lim exec tap ios_abc123 100 200     # ~2s (connect + auth + tap + disconnect)
lim exec element-tree ios_abc123    # ~2s (connect + auth + fetch + disconnect)
# Total: ~6s for 3 commands
```

With a session, the connection is created once and reused:

```
lim session start ios_abc123        # ~2s (one-time connection setup)
lim exec screenshot ios_abc123      # ~50ms (reuses connection)
lim exec tap ios_abc123 100 200     # ~50ms (reuses connection)
lim exec element-tree ios_abc123    # ~50ms (reuses connection)
lim session stop                    # instant cleanup
# Total: ~2.15s for 3 commands
```

This makes sessions essential for interactive workflows, AI agent loops, and any scenario where you run multiple `exec` commands against the same instance.

#### Session Commands

```bash
# Start a session (spawns background daemon)
lim session start ios_abc123
lim session start android_abc123

# Check session status
lim session status
lim session status --json

# Stop the session (disconnects and kills daemon)
lim session stop
```

#### How It Works

`lim session start` spawns a lightweight background daemon that:
- Holds a persistent WebSocket connection to the instance
- Listens on a local Unix socket for commands
- All `exec` commands automatically detect the running session and route through it
- No code changes needed in your scripts — just add `session start` before and `session stop` after

The session state is stored in `/tmp/lim-session/`. If the daemon crashes, just run `session start` again.

#### Example: Interactive Testing with Sessions

```bash
# Start instance and session
lim run ios --model iphone
lim session start ios_abc123

# Fast interaction loop — each command takes ~50ms
lim exec launch-app ios_abc123 com.example.myapp
lim exec element-tree ios_abc123 | jq '.tree'
lim exec tap-element ios_abc123 --label "Login"
lim exec type ios_abc123 "user@example.com"
lim exec tap-element ios_abc123 --label "Submit"
lim exec screenshot ios_abc123 -o after-login.png

# Clean up
lim session stop
lim delete ios_abc123
```

#### Example: AI Agent Loop with Sessions

```bash
ID="ios_abc123"
lim session start $ID

# Agent can run hundreds of commands with minimal latency
for i in $(seq 1 10); do
  lim exec screenshot $ID -o "step_${i}.png"
  lim exec element-tree $ID --json > "tree_${i}.json"
  # ... agent decides next action ...
  lim exec tap $ID $X $Y
done

lim session stop
```

---

### Device Interaction

The `exec` commands let you interact with running Android and iOS instances directly from the command line. These commands auto-detect the platform from the instance ID prefix. When a [session](#sessions) is active, commands route through it automatically for near-instant execution.

#### Screenshots

```bash
# Save to file
lim exec screenshot ios_abc123 -o screenshot.png

# Output base64 to stdout (for piping)
lim exec screenshot ios_abc123

# JSON output with metadata
lim exec screenshot ios_abc123 --json
```

#### Tapping

```bash
# Tap at coordinates
lim exec tap ios_abc123 100 200

# Tap an element by accessibility selector
lim exec tap-element ios_abc123 --label "Submit"
lim exec tap-element ios_abc123 --accessibility-id btn_ok

# Android: tap by resource ID or text
lim exec tap-element android_abc123 --resource-id com.example:id/button
lim exec tap-element android_abc123 --text "Sign In"
```

#### Text Input

```bash
# Type text into the focused field
lim exec type ios_abc123 "Hello World"

# Type and press Enter (iOS)
lim exec type ios_abc123 "search query" --press-enter

# Press a key
lim exec press-key ios_abc123 enter
lim exec press-key ios_abc123 a --modifier shift
```

#### Scrolling

```bash
lim exec scroll ios_abc123 down --amount 500
lim exec scroll android_abc123 up --amount 300
```

#### UI Inspection

```bash
# Get the element/accessibility tree
lim exec element-tree ios_abc123
lim exec element-tree android_abc123

# Pipe to jq for filtering
lim exec element-tree ios_abc123 | jq '.'
```

#### App Management (iOS)

```bash
# Install an app from local file (auto-uploads)
lim exec install-app ios_abc123 ./MyApp.ipa

# Install from URL
lim exec install-app ios_abc123 https://example.com/app.ipa

# Launch / terminate
lim exec launch-app ios_abc123 com.example.myapp
lim exec launch-app ios_abc123 com.example.myapp --mode RelaunchIfRunning
lim exec terminate-app ios_abc123 com.example.myapp

# List installed apps
lim exec list-apps ios_abc123
```

#### Open URLs

```bash
# Open web URL (opens in browser on the device)
lim exec open-url ios_abc123 https://example.com

# Open deep link
lim exec open-url ios_abc123 myapp://settings
```

#### Log Streaming (iOS)

```bash
# Tail recent logs
lim exec log ios_abc123 com.example.myapp --lines 50

# Stream logs continuously (Ctrl+C to stop)
lim exec log ios_abc123 com.example.myapp -f
```

#### Video Recording

```bash
# Start recording
lim exec record ios_abc123 start
lim exec record ios_abc123 start --quality 8

# Stop and save
lim exec record ios_abc123 stop -o recording.mp4
```

---

### Xcode Build Pipeline

Build and test iOS apps remotely using cloud Xcode sandboxes. The `sync` and `build` commands work with both standalone Xcode instances and iOS instances that have Xcode sandbox enabled.

#### Option A: iOS Instance with Xcode Sandbox (Recommended)

This gives you a simulator **and** a build environment in one instance — the built app is automatically installed on the simulator.

```bash
# 1. Create iOS instance with Xcode sandbox
lim run ios --xcode
# Output:
#   Instance ID: ios_abc123
#   Xcode Sandbox: https://...limrun.net/v1/sandbox_.../xcode
#   (sandbox URL is cached locally for sync/build to use)

# 2. Sync your project code to the Xcode sandbox
lim sync ios_abc123 ./MyProject

# 3. Build — the app is auto-installed on the simulator
lim build ios_abc123 --scheme MyApp --workspace MyApp.xcworkspace

# 4. Start a session for fast device interaction
lim session start ios_abc123

# 5. Test the built app on the simulator (~50ms per command)
lim exec launch-app ios_abc123 com.example.myapp
lim exec element-tree ios_abc123 | jq '.'
lim exec screenshot ios_abc123 -o built-app.png

# 6. Clean up
lim session stop
lim delete ios_abc123
```

> **Note:** The Xcode sandbox URL is only returned when the instance is created — not on subsequent `get` calls. The CLI caches it locally at `~/.lim/instances/` so that `sync` and `build` can find it. This means `sync`/`build` must run on the same machine where `run ios --xcode` was executed.

#### Option B: Standalone Xcode Instance

Use this when you only need to build (no simulator needed), or when you want to attach a simulator separately.

```bash
# 1. Create a standalone Xcode instance
lim run xcode --rm

# 2. Sync and build
lim sync xcode_abc123 ./MyProject
lim build xcode_abc123 --scheme MyApp --workspace MyApp.xcworkspace

# 3. Upload build artifact
lim build xcode_abc123 --scheme MyApp --upload my-app-build

# 4. Download the artifact
lim pull my-app-build -o ./build-output
```

#### Sync Options

```bash
# Watch mode (re-syncs on file changes, default)
lim sync ios_abc123 ./MyProject --watch

# One-shot sync (no watch)
lim sync ios_abc123 ./MyProject --no-watch

# Sync without installing
lim sync ios_abc123 ./MyProject --no-install
```

The sync automatically ignores build artifacts (`build/`, `DerivedData/`, `.build/`), dependency folders (`Pods/`, `Carthage/Build/`, `.swiftpm/`), and user-specific files (`xcuserdata/`, `.dSYM/`).

---

### Connectivity

#### Android ADB Tunnel

Connect to a running Android instance for `adb` access:

```bash
# Connect to an existing instance
lim connect android android_abc123

# With custom adb path
lim connect android android_abc123 --adb-path /usr/local/bin/adb
```

The tunnel stays open until you press Ctrl+C. While connected, you can use `adb` commands in another terminal.

---

## Configuration

The CLI reads configuration from multiple sources (in order of precedence):

1. Command-line flags (`--api-key`)
2. Environment variables (`LIM_API_KEY`, `LIM_API_ENDPOINT`, `LIM_CONSOLE_ENDPOINT`)
3. Config file (`~/.lim/config.yaml`)

**Config file keys:**

| Key | Default | Description |
|-----|---------|-------------|
| `api-key` | — | Your Limrun API key |
| `api-endpoint` | `https://api.limrun.com` | API base URL |
| `console-endpoint` | `https://console.limrun.com` | Console URL (for login) |

---

## JSON Output

All commands support `--json` for machine-readable output, making the CLI suitable for scripting and AI agent automation:

```bash
# Get instance details as JSON
lim get ios ios_abc123 --json

# Parse with jq
lim get android --json | jq '.[].metadata.id'

# Use in scripts
INSTANCE_ID=$(lim run ios --json | jq -r '.metadata.id')
lim exec screenshot $INSTANCE_ID -o test.png
lim delete $INSTANCE_ID
```

---

## Workflows

### CI Testing: Install and Verify an App

```bash
INSTANCE_ID="ios_..."

# Create instance and start session for fast commands
lim run ios --install ./build/MyApp.ipa
lim session start $INSTANCE_ID

# Verify — each command takes ~50ms with session
lim exec launch-app $INSTANCE_ID com.example.myapp
sleep 2
lim exec element-tree $INSTANCE_ID | grep "Welcome"
lim exec screenshot $INSTANCE_ID -o test-result.png

# Clean up
lim session stop
lim delete $INSTANCE_ID
```

### AI Agent Automation

```bash
# Create instance
INSTANCE=$(lim run ios --model iphone --json)
ID=$(echo $INSTANCE | jq -r '.metadata.id')

# Start session — all exec commands now run in ~50ms
lim session start $ID

# Agent can interact at high speed
lim exec tap $ID 200 400
lim exec type $ID "test@example.com"
lim exec tap-element $ID --label "Sign In"
lim exec screenshot $ID -o result.png
lim exec element-tree $ID --json > ui-state.json

# Tail logs (non-streaming works through session too)
lim exec log $ID com.example.myapp --lines 20

# Clean up
lim session stop
lim delete $ID
```

### Remote Build + Test on iOS Simulator

```bash
# Single instance: Xcode sandbox + iOS simulator
ID=$(lim run ios --xcode --json | jq -r '.metadata.id')

# Sync, build, and test
lim sync $ID ./MyiOSProject --no-watch
lim build $ID --scheme MyApp --workspace MyApp.xcworkspace

# Verify the built app on the simulator
lim session start $ID
lim exec launch-app $ID com.example.myapp
sleep 2
lim exec element-tree $ID | grep "Welcome"
lim exec screenshot $ID -o test-result.png
lim session stop

lim delete $ID
```

### Build-Only with Artifact Upload

```bash
lim run xcode --rm --reuse-if-exists --label project=myapp
XCODE_ID="xcode_..."

lim sync $XCODE_ID ./MyiOSProject --no-watch
lim build $XCODE_ID --scheme MyApp --workspace MyApp.xcworkspace --upload myapp-latest
lim pull myapp-latest -o ./build-output
```
