# Device Install

An end-to-end physical iPhone installation example with two methods:

- **WebUSB** registers and pairs the selected iPhone, creates development
  signing, builds a private IPA, and starts installation automatically.
- **QR / private OTA** registers the selected iPhone without requiring a pair
  record, creates ad-hoc signing, builds a private IPA, and renders a QR code
  for Limrun's short-lived private install page.

## Architecture

The frontend signs into Apple through `@limrun/apple-auth`, selects a team and
bundle ID, and uses `@limrun/device-install` for device discovery, pairing,
automatic installation, and OTA progress. The selected iPhone's UDID is
registered with Apple before a device-specific profile is created:

- WebUSB uses a development certificate/profile and requires browser pairing.
- QR uses a distribution certificate/ad-hoc profile and does not require
  pairing. USB selection is used only to identify the target UDID.

Signing material is written through a `SigningSecretStore` backed by the
directory in the UI's "Secrets directory" field — pre-filled with the
backend's default (`backend/.secrets/`, or `SECRETS_DIR` when the backend
was started with it). When the [`publish-to-stores`](../publish-to-stores)
example ran its Connect checklist with the device-install actions selected
and both UIs point at the same directory, the stored certificates and
profiles are reused here: an iPhone already covered by those profiles
installs without another Apple sign-in. The backend then runs:

```text
lim xcode build <project> --sdk iphoneos --configuration Release \
  --certificate-p12 ... --provisioning-profile ... \
  --upload device-install-<method>-<bundle>-<id>.ipa \
  --webhook-url ... --webhook-header X-Install-Token=... --detach
```

Only the token-guarded webhook receiver on port 3001 is exposed publicly,
through the webhook URL entered in the UI. That URL is used verbatim as the
callback URL — nothing is appended — and the webhook is matched to its build
by the per-install `X-Install-Token` header alone. The local API and
signing-secret store stay on port 3000.

The browser initially receives only `device:*:install`. After a successful
build webhook, it exchanges that build's install ID for a fresh scoped token
containing `asset:<exact-uploaded-asset-id>:read`. There is no wildcard asset
grant and no asset-name-only installation path.

For WebUSB, the asset-scoped token is fed back into
`useDeviceInstallRelay`, which automatically streams the IPA to the paired
iPhone. For QR, `useOTAInstall` creates a private OTA capability from the IPA
metadata in the build webhook. The UI renders its QR code and reports how many
IPA bytes the registry has served. iOS does not expose final verification or
installation completion.

## Requirements

- Node.js and Yarn 1
- The `lim` CLI on `PATH`
- `LIM_API_KEY`
- A public HTTPS URL that forwards to the webhook receiver on port 3001,
  entered in the UI's Webhook URL field. Builds run inside Limrun's cloud
  and report completion by webhook, and limbuild rejects private and
  IP-literal callback URLs — use a tool like [ngrok](https://ngrok.com)
  (`ngrok http 3001`), or [requestbin.net](https://requestbin.net) if you
  only want to inspect the payload (the wizard then never sees completion)
- An Apple Developer Program account
- Desktop Chrome or Edge in a secure context (`http://localhost` works)
- A physical, unlocked iPhone connected over USB for target selection

Safari and Firefox do not expose WebUSB. Pairing is required only for the
automatic WebUSB method; QR installation itself happens on the iPhone.

## Run

```bash
export LIM_API_KEY="your api key"
yarn --cwd examples/device-install/backend install
yarn --cwd examples/device-install/frontend install
yarn --cwd examples/device-install/backend dev
```

In another terminal:

```bash
yarn --cwd examples/device-install/frontend dev
```

Open `http://localhost:5173`:

1. Enter the webhook URL in the sidebar (e.g. from `ngrok http 3001`), sign
   in with Apple, choose a team, and choose or create a bundle ID.
2. Enter the project path on the backend host and select WebUSB or QR.
3. Select the iPhone. For WebUSB, pair it and tap Trust.
4. Register the device and prepare method-specific signing.
5. Start the detached build. Wait for automatic WebUSB installation or scan
   the QR code on the registered iPhone.

`backend/.secrets/` contains private keys and is gitignored. Build state is
kept in memory for this example.
