# @limrun/apple-auth

Browser primitives for signing in with an Apple ID and managing Apple
Developer and App Store Connect resources through Limrun's Apple relay.

The package exports Apple login, teams, bundle IDs, certificates,
provisioning profiles, App Store Connect API keys and app records, signing
crypto, and pluggable signing-secret stores:

```ts
import { createAppleProfile, ensureAppleCertificateSecret, listAppleTeams } from '@limrun/apple-auth';
```

React applications can use the thin Apple ID login state helper:

```ts
import { useAppleIDLogin } from '@limrun/apple-auth/react';
```

Signing secrets remain under the caller's control through
`SigningSecretStore`. Limrun's org secret store (`createLimrunSecretStore`)
is the included implementation; applications that keep secrets themselves
implement the interface over their own storage — a database, a KMS,
anything — like the publish-to-stores example does with its backend.
