# Publish to Stores

An end-to-end TestFlight and App Store publishing example. The browser signs
into Apple, prepares App Store credentials, and asks the backend to run a
detached `lim xcode build`. The terminal build result arrives through an
authenticated build-finish webhook.

Device installation is intentionally separate; see
[`examples/device-install`](../device-install).

## Architecture

- `frontend/` uses `@limrun/apple-auth` to sign into Apple through Limrun's
  registry relay, choose or create a bundle ID, and prepare exactly four
  resources: an Apple distribution certificate, App Store provisioning
  profile, App Store Connect app record, and App Store Connect API key.
- `backend/` keeps `LIM_API_KEY` server-side, mints a short-lived
  `applerelay:*:connect` scoped token, stores signing secrets as files under
  `backend/.secrets/`, runs `lim xcode build --detach
  --upload-to-testflight`, and tracks the callback.
- The webhook receiver listens separately on port 3001. Only its
  token-guarded route is exposed through localtunnel (or `PUBLIC_URL`); the
  secret store and token-minting routes remain local on port 3000.

Both UI choices upload to App Store Connect. TestFlight links to the uploaded
builds; App Store links to the distribution page where the processed build can
be attached to a version and submitted for review.

## Requirements

- Node.js and Yarn 1
- The `lim` CLI on `PATH`
- `LIM_API_KEY`
- An Apple Developer Program account with permission to create App Store
  Connect API keys

## Run

```bash
export LIM_API_KEY="your api key"
yarn --cwd examples/publish-to-stores/backend install
yarn --cwd examples/publish-to-stores/frontend install
yarn --cwd examples/publish-to-stores/backend dev
```

In another terminal:

```bash
yarn --cwd examples/publish-to-stores/frontend dev
```

Open `http://localhost:5173`, complete Apple setup, enter a project path that
exists on the backend host, and choose TestFlight or App Store.

Set `PUBLIC_URL` to a public HTTPS URL forwarded to port 3001 to replace the
automatic localtunnel. The backend passes both a random per-publish
`X-Publish-Token` and `Bypass-Tunnel-Reminder=true` to limbuild; invalid tokens
receive the same 404 as unknown publish IDs.

`backend/.secrets/` contains private keys and is gitignored. The in-memory
publish registry is demo-only and is lost when the backend restarts.
