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

### Supported requests and limitations

The relay supports allowlisted form POST and query GET requests to
`developer.apple.com/services-account/QH65B2`. Apple's private endpoints can
change independently.

The following Developer Portal calls remain unsupported:

| Path                                                                                       | Reason                                     |
| ------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `/account/listPendingAgreements`                                                           | JSON POST body                             |
| `/account/getTeamMembers`                                                                  | JSON POST body                             |
| `/account/getInvites`                                                                      | JSON POST body                             |
| `/account/setTeamMemberRoles`                                                              | JSON POST body                             |
| `/account/removeTeamMembers`                                                               | JSON POST body                             |
| `/account/sendInvites`                                                                     | JSON POST body                             |
| `/account/auth/key/v2/create`                                                              | JSON POST body                             |
| `https://developerservices2.apple.com/services/QH65B2/ios/listProvisioningProfiles.action` | Different upstream host and plist response |
| `https://developerservices2.apple.com/services/QH65B2/mac/listProvisioningProfiles.action` | Different upstream host and plist response |

The normal Developer Portal profile list is supported. The separate App Store
Connect `iris` API and the public JWT API are outside this portal inventory.
