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

## Developer Portal resources

All helpers use the existing Apple ID relay session and accept `{ relay, teamId }`.
Operations supported in both portal namespaces also accept `platform: 'ios' | 'mac'`,
with `ios` as the default. New resource types retain Apple's wire field names.
For example, `applicationGroup` is the opaque ID for assignments, while `identifier`
is the `group.com.example.shared` value used in entitlements.

| Resource                | Helpers                                                                                                                                                        | Platforms                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| App Groups              | `listAppleAppGroups`, `createAppleAppGroup`, `ensureAppleAppGroup`, `deleteAppleAppGroup`, `assignAppleAppGroups`                                              | iOS                             |
| App ID details and name | `getAppleBundleIDDetails`, `renameAppleBundleID`                                                                                                               | iOS, Mac                        |
| Capabilities and push   | `updateAppleAppService`                                                                                                                                        | iOS                             |
| iCloud containers       | `listAppleCloudContainers`, `createAppleCloudContainer`, `assignAppleCloudContainers`                                                                          | Team resources; iOS assignments |
| Apple Pay merchant IDs  | `listAppleMerchantIDs`, `createAppleMerchantID`, `deleteAppleMerchantID`, `assignAppleMerchantIDs`                                                             | iOS, Mac                        |
| Merchant domains        | `listAppleMerchantDomains`, `registerAppleMerchantDomain`, `downloadAppleMerchantDomainVerification`, `verifyAppleMerchantDomain`, `deleteAppleMerchantDomain` | iOS, Mac                        |
| Wallet pass type IDs    | `listApplePassTypeIDs`, `createApplePassTypeID`, `deleteApplePassTypeID`                                                                                       | iOS                             |
| Website push IDs        | `listAppleWebsitePushIDs`, `createAppleWebsitePushID`, `deleteAppleWebsitePushID`                                                                              | iOS, Mac                        |
| Profiles                | `getAppleProfileDetails`, `regenerateAppleProfile`                                                                                                             | iOS, Mac                        |
| Devices                 | `enableAppleDevice`; `listAppleDevices` also accepts `includeDisabled` and `deviceClass`                                                                       | iOS, Mac                        |
| Developer Portal keys   | `listAppleDeveloperKeys`, `getAppleDeveloperKey`, `downloadAppleDeveloperKey`, `revokeAppleDeveloperKey`                                                       | Team resources                  |

The existing bundle ID, certificate, device, and profile helpers also accept
`platform`. Developer Portal keys are separate from App Store Connect API keys.
Downloads return the original bytes as `rawBodyBase64`; decode that once to get
the key or verification file. JSON and HTTP errors reject the promise.

`updateAppleAppService` takes Apple's `featureType` and `featureValue`. App Groups
uses `APG3427HIY` with `true`; push uses `push` and selects Apple's separate push
endpoint. Assignment helpers send the entire supplied array of opaque record IDs.
Read existing assignments and merge them before adding a new one. They do not
implicitly enable capabilities or refresh provisioning profiles.

New resource lists fetch all pages. Mutating helpers refresh the relevant CSRF
headers through a list request before the write. Await setup calls sequentially
on a shared relay session, since Apple session headers change between resources.

### Sharing an App Group with a widget

```ts
import {
  ensureAppleAppGroup,
  getAppleBundleIDDetails,
  updateAppleAppService,
  assignAppleAppGroups,
} from '@limrun/apple-auth';

// Use the authenticated relay and the selected Developer Portal team.
const group = await ensureAppleAppGroup({
  relay,
  teamId,
  identifier: 'group.com.example.shared',
  name: 'Shared widget data',
});

// These are Apple's opaque App ID record IDs, not bundle identifier strings.
for (const appIdId of [mainAppIdId, widgetAppIdId]) {
  const details = await getAppleBundleIDDetails({ relay, teamId, appIdId });
  const applicationGroups = [
    ...new Set([
      ...(details.associatedApplicationGroups ?? []).map((g) => g.applicationGroup),
      group.applicationGroup,
    ]),
  ];
  await updateAppleAppService({
    relay,
    teamId,
    appIdId,
    featureType: 'APG3427HIY',
    featureValue: true,
  });
  await assignAppleAppGroups({ relay, teamId, appIdId, applicationGroups });
}
```

After changing capabilities or assignments, create or regenerate each affected
bundle's provisioning profile and download it again. For cloud signing, pass
`com.apple.security.application-groups` in the entitlements for both the main app
and widget using `--entitlements` or the SDK's per-bundle `entitlements` map.

### Developer service keys and agreements

The following helpers use the same `{ relay, teamId }` session:

| Operation                                    | Helper                       |
| -------------------------------------------- | ---------------------------- |
| Read outstanding agreements                  | `listApplePendingAgreements` |
| Create an APNs, DeviceCheck, or MusicKit key | `createAppleDeveloperKey`    |

The relay selects JSON encoding for these endpoints. Callers use the same
`provisioning` request type as the other portal helpers. Key creation refreshes
key CSRF headers before the write.

```ts
import { createAppleDeveloperKey, downloadAppleDeveloperKey } from '@limrun/apple-auth';

const key = await createAppleDeveloperKey({
  relay,
  teamId,
  name: 'App notifications',
  apns: true,
});
const privateKey = await downloadAppleDeveloperKey({ relay, teamId, keyId: key.keyId });
// Decode privateKey.rawBodyBase64 once to obtain the .p8 private key bytes.
```

`apns: true` requests a team-scoped key for development and production, matching
Fastlane's default. Add `deviceCheck: true` or `musicId: '<opaque Music ID>'` to
configure those services. These are Developer Portal service keys, separate
from App Store Connect API keys and code-signing certificates. Creation returns
a key record; private bytes are downloaded separately and remain under the
caller's control.

`listApplePendingAgreements` returns Apple's full response envelope; its optional
`language` defaults to `en`. It does not accept agreements.

### Fastlane coverage and remaining calls

Endpoint inventory checked against Fastlane's
[PortalClient](https://github.com/fastlane/fastlane/blob/1912c0760355eebb5e90f643e6e77b74cf346e3b/spaceship/lib/spaceship/portal/portal_client.rb)
and [AppService](https://github.com/fastlane/fastlane/blob/1912c0760355eebb5e90f643e6e77b74cf346e3b/spaceship/lib/spaceship/portal/app_service.rb).
The relay supports form POST, JSON POST, and query GET calls on
`developer.apple.com/services-account/QH65B2`, including both namespaces where
Fastlane implements them, except for the calls listed below. This covers endpoint
access, not every Fastlane CLI workflow or option. Apple's private endpoints can change independently.

The following Fastlane Developer Portal calls remain unsupported:

| Path                                                                                       | Reason                                     |
| ------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `/account/getTeamMembers`                                                                  | Apple returns HTTP 404 for this endpoint   |
| `/account/getInvites`                                                                      | Apple returns HTTP 404 for this endpoint   |
| `/account/setTeamMemberRoles`                                                              | Requires the unavailable team-members API  |
| `/account/removeTeamMembers`                                                               | Requires the unavailable team-members API  |
| `/account/sendInvites`                                                                     | Requires the unavailable team-members API  |
| `https://developerservices2.apple.com/services/QH65B2/ios/listProvisioningProfiles.action` | Different upstream host and plist response |
| `https://developerservices2.apple.com/services/QH65B2/mac/listProvisioningProfiles.action` | Different upstream host and plist response |

The normal Developer Portal profile list is supported. The separate App Store
Connect `iris` API and the public JWT API are outside this portal inventory.
