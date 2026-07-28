// The Connect phase: a one-time flow that signs into Apple, resolves the
// team and bundle ID, and materializes everything a publish — and,
// optionally, the device-install example — later needs: certificates,
// provisioning profiles, the App Store Connect app record and an App
// Store Connect API key — into the backend's secret store. Read
// top-to-bottom it doubles as a reference for the `@limrun/apple-auth`
// APIs.
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  APP_STORE_CONNECT_API_KEY_SECRET_TYPE,
  APPLE_CERTIFICATE_SECRET_TYPE,
  APPLE_PROVISIONING_PROFILE_SECRET_TYPE,
  appleCertificateSecretName,
  appStoreConnectApiKeySecretName,
  createAppleBundleID,
  createAppleProfile,
  deleteAppleProfile,
  downloadAppleProfile,
  ensureAppleCertificateSecret,
  ensureAppStoreConnectApiKeySecret,
  ensureAppStoreConnectApp,
  findAppStoreConnectApp,
  listAppleBundleIDs,
  listAppleDevices,
  listAppleProfiles,
  listAppleTeams,
  parseProvisioningProfileBase64,
  profileContainsDevice,
  saveAppleProfileSecret,
  switchAppStoreConnectProvider,
  type AppleBundleID,
  type AppleRelayWebSocketClient,
  type AppleTeam,
  type EnsureAppleCertificateResult,
  type SigningSecretStore,
} from '@limrun/apple-auth';
import { useAppleIDLogin } from '@limrun/apple-auth/react';
import { naming } from '../config';
import { errorMessage } from '../lib/apple';
import { fetchRegistrySession, type RegistrySession } from '../lib/backend';

/**
 * The deselectable actions of the Connect checklist. The bundle ID itself is
 * always ensured because every profile depends on it. The first four cover
 * publishing; the last three prepare the signing material the
 * device-install example uses for QR code and WebUSB installs.
 */
export const CONNECT_ACTIONS = [
  {
    id: 'distributionCertificate',
    label: 'App distribution certificate',
    description: 'Signs TestFlight, App Store and ad-hoc builds.',
  },
  {
    id: 'appStoreProfile',
    label: 'App Store provisioning profile',
    description: 'For TestFlight and App Store uploads.',
  },
  {
    id: 'appRecord',
    label: 'App Store Connect app record',
    description: 'Required before the first upload of a new bundle ID.',
  },
  {
    id: 'apiKey',
    label: 'App Store Connect API key',
    description: 'Authenticates the TestFlight/App Store upload.',
  },
  {
    id: 'developmentCertificate',
    label: 'Development certificate',
    description: 'Signs WebUSB device installs (the device-install example).',
  },
  {
    id: 'adHocProfile',
    label: 'Ad-hoc provisioning profile',
    description: "Covers the team's registered iPhones for QR code installs.",
  },
  {
    id: 'developmentProfile',
    label: 'Development provisioning profile',
    description: "Covers the team's registered iPhones for WebUSB installs.",
  },
] as const;

export type ConnectActionId = (typeof CONNECT_ACTIONS)[number]['id'];

export type ActionStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error';

export type ActionState = { status: ActionStatus; note?: string };

export type Connection = {
  teamId: string;
  bundleId: string;
  appName: string;
  /**
   * Numeric App Store Connect app record ID, captured when the app record
   * action runs. Used to link to the app's App Store Connect page after a
   * publish.
   */
  ascAppId?: string;
};

const CONNECTION_STORAGE_KEY = 'publish-to-stores.connection';

/** Sentinel for the bundle ID picker's "register a new one" option. */
export const NEW_BUNDLE_ID = '__new__';

function isUnexpired(expirationDate?: string) {
  if (!expirationDate) return true;
  const expiresAt = Date.parse(expirationDate);
  return Number.isNaN(expiresAt) || expiresAt > Date.now();
}

type ConnectContext = {
  secretStore: SigningSecretStore;
  log: (message: string, detail?: string) => void;
  onError: (message?: string) => void;
};

export type ConnectController = ReturnType<typeof useConnect>;

export function useConnect({ secretStore, log, onError }: ConnectContext) {
  const [busy, setBusy] = useState<string>();

  // The Apple relay connection goes straight to Limrun's registry,
  // authenticated with a short-lived scoped token minted by the example
  // backend (POST /session) — the API key never reaches the browser, and
  // the token can only open the Apple relay. No Xcode instance is created
  // for Connect; the first one appears when a publish runs the CLI.
  const [registrySession, setRegistrySession] = useState<RegistrySession>();
  useEffect(() => {
    let cancelled = false;
    void fetchRegistrySession()
      .then((session) => {
        if (!cancelled) setRegistrySession(session);
      })
      .catch((error: unknown) => {
        if (!cancelled) onError(errorMessage(error, 'Could not reach the example backend'));
      });
    return () => {
      cancelled = true;
    };
  }, [onError]);
  const appleLogin = useAppleIDLogin({
    registryApiUrl: registrySession?.registryUrl ?? '',
    token: registrySession?.token,
  });
  const [appleAccount, setAppleAccount] = useState('');
  const [applePassword, setApplePassword] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');

  const [teams, setTeams] = useState<AppleTeam[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [bundleId, setBundleId] = useState('');
  const [bundleIdChoice, setBundleIdChoice] = useState(NEW_BUNDLE_ID);
  const [portalAppIds, setPortalAppIds] = useState<AppleBundleID[]>([]);
  const [bundleIdsLoading, setBundleIdsLoading] = useState(false);
  const [appName, setAppName] = useState('');
  const [selectedActions, setSelectedActions] = useState<Set<ConnectActionId>>(
    () => new Set(CONNECT_ACTIONS.map((action) => action.id)),
  );
  const [actionStates, setActionStates] = useState<Partial<Record<ConnectActionId, ActionState>>>({});
  const [connection, setConnection] = useState<Connection>();

  const selectedTeam = teams.find((team) => team.teamId === selectedTeamId);
  const teamId = selectedTeam?.teamId;
  const relay = appleLogin.session?.relay;
  const loggedIn = appleLogin.status === 'authenticated' && !!relay;

  // A returning user is already connected when the store still holds the
  // team's distribution certificate, an App Store profile, and the App
  // Store Connect API key from an earlier session.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const raw = localStorage.getItem(CONNECTION_STORAGE_KEY);
      if (!raw) return;
      let stored: Connection;
      try {
        stored = JSON.parse(raw) as Connection;
      } catch {
        localStorage.removeItem(CONNECTION_STORAGE_KEY);
        return;
      }
      try {
        const secrets = await secretStore.list();
        const has = (type: string, name: string) =>
          secrets.some((secret) => secret.type === type && secret.name === name);
        const hasProfile = secrets.some(
          (secret) =>
            secret.type === APPLE_PROVISIONING_PROFILE_SECRET_TYPE &&
            secret.name.startsWith(`${stored.teamId}/`),
        );
        const storeReady =
          has(APPLE_CERTIFICATE_SECRET_TYPE, appleCertificateSecretName(stored.teamId, 'DISTRIBUTION')) &&
          has(APP_STORE_CONNECT_API_KEY_SECRET_TYPE, appStoreConnectApiKeySecretName(stored.teamId)) &&
          hasProfile;
        if (storeReady) {
          if (!cancelled) {
            setConnection(stored);
            setBundleId(stored.bundleId);
            setAppName(stored.appName);
          }
        } else {
          localStorage.removeItem(CONNECTION_STORAGE_KEY);
        }
      } catch {
        // Backend not reachable yet; the user can still connect manually.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [secretStore]);

  // Existing bundle IDs on the portal for the selected team, so the user can
  // pick one instead of registering a new one. Wildcard app IDs (com.acme.*)
  // are excluded — they cannot carry App Store profiles or app records.
  useEffect(() => {
    if (!loggedIn || !relay || !teamId) {
      setPortalAppIds([]);
      setBundleIdChoice(NEW_BUNDLE_ID);
      return;
    }
    let cancelled = false;
    setBundleIdsLoading(true);
    void listAppleBundleIDs({ relay, teamId })
      .then((appIds) => {
        if (cancelled) return;
        setPortalAppIds(appIds.filter((appId) => !appId.bundleId.includes('*')));
      })
      .catch((error: unknown) => {
        if (!cancelled) onError(errorMessage(error, 'Could not list the existing bundle IDs'));
      })
      .finally(() => {
        if (!cancelled) setBundleIdsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loggedIn, relay, teamId, onError]);

  // When a bundle ID restored from a previous session already exists on the
  // portal, preselect it instead of leaving the "register new" input filled.
  useEffect(() => {
    if (bundleIdChoice !== NEW_BUNDLE_ID) return;
    const trimmed = bundleId.trim();
    if (trimmed && portalAppIds.some((appId) => appId.bundleId === trimmed)) {
      setBundleIdChoice(trimmed);
    }
  }, [portalAppIds, bundleId, bundleIdChoice]);

  // Prefill the app name from the App Store Connect app record when an
  // existing bundle ID is selected — that name is the one shown on the App
  // Store. The Developer Portal registration name is deliberately not used:
  // tools often register bundle IDs under generated names like
  // "appexamplemyapp <hash>". Without an app record the field is left for
  // the user to fill. Still editable afterwards.
  useEffect(() => {
    if (bundleIdChoice === NEW_BUNDLE_ID || !relay) return;
    let cancelled = false;
    void (async () => {
      try {
        const providerId = selectedTeam?.providerId;
        if (providerId) await switchAppStoreConnectProvider({ relay, providerId });
        const app = await findAppStoreConnectApp({ relay, bundleId: bundleIdChoice });
        if (!cancelled && app?.name) setAppName(app.name);
      } catch {
        // No App Store Connect access or no app record yet; the user
        // types the name themselves.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bundleIdChoice, relay, selectedTeam]);

  const toggleAction = useCallback((id: ConnectActionId) => {
    setSelectedActions((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // --- Step 1: Apple ID login -----------------------------------------------

  const loadTeams = useCallback(
    async (relayClient: AppleRelayWebSocketClient) => {
      // finalize() fetches the account session Apple requires before the
      // provisioning endpoints work.
      await appleLogin.finalize().catch(() => undefined);
      const loaded = await listAppleTeams({ relay: relayClient });
      setTeams(loaded);
      setSelectedTeamId(loaded[0]?.teamId ?? '');
      log('Apple teams loaded', String(loaded.length));
    },
    [appleLogin, log],
  );

  const signIn = useCallback(async () => {
    if (!registrySession) {
      onError('The registry session is not ready yet; is the example backend running?');
      return;
    }
    onError(undefined);
    setBusy('login');
    try {
      const session = await appleLogin.startLogin({ accountName: appleAccount, password: applePassword });
      if (session && !session.requiresTwoFactor) {
        setApplePassword('');
        await loadTeams(session.relay);
      }
    } catch (error) {
      onError(errorMessage(error, 'Apple sign-in failed'));
    } finally {
      setBusy(undefined);
    }
  }, [appleAccount, applePassword, appleLogin, loadTeams, onError, registrySession]);

  const submitTwoFactor = useCallback(async () => {
    if (!appleLogin.session) return;
    onError(undefined);
    setBusy('2fa');
    try {
      const response = await appleLogin.submitTwoFactorCode(twoFactorCode);
      if (response) {
        setTwoFactorCode('');
        setApplePassword('');
        await loadTeams(appleLogin.session.relay);
      }
    } catch (error) {
      onError(errorMessage(error, 'Two-factor verification failed'));
    } finally {
      setBusy(undefined);
    }
  }, [appleLogin, loadTeams, onError, twoFactorCode]);

  // --- Step 2: run the checklist --------------------------------------------

  const setActionState = useCallback((id: ConnectActionId, state: ActionState) => {
    setActionStates((current) => ({ ...current, [id]: state }));
  }, []);

  const confirm = useCallback(async () => {
    if (!relay || !teamId) return onError('Sign in with Apple and select a team first.');
    const trimmedBundleId = (bundleIdChoice === NEW_BUNDLE_ID ? bundleId : bundleIdChoice).trim();
    const trimmedAppName = appName.trim();
    if (!trimmedBundleId) return onError('Enter a bundle ID or pick an existing one.');
    if (selectedActions.has('appRecord') && !trimmedAppName) {
      return onError('Enter an app name; it is used for the App Store Connect app record.');
    }

    onError(undefined);
    setBusy('confirm');
    setActionStates(
      Object.fromEntries(
        CONNECT_ACTIONS.filter((action) => selectedActions.has(action.id)).map((action) => [
          action.id,
          { status: 'pending' } as ActionState,
        ]),
      ),
    );

    // Actions return a note string, or `{ skipped }` when there is nothing
    // to do (e.g. a device profile with no registered devices).
    const run = async (
      id: ConnectActionId,
      action: () => Promise<string | { skipped: string } | undefined>,
    ) => {
      if (!selectedActions.has(id)) return;
      setActionState(id, { status: 'running' });
      try {
        const result = await action();
        if (typeof result === 'object') setActionState(id, { status: 'skipped', note: result.skipped });
        else setActionState(id, { status: 'done', note: result });
      } catch (error) {
        setActionState(id, { status: 'error', note: errorMessage(error, 'Failed') });
        throw error;
      }
    };
    try {
      // Bundle ID: every profile and the app record hang off it, so it is
      // ensured unconditionally rather than being a checklist item.
      let appIdId: string;
      {
        const existing = await listAppleBundleIDs({ relay, teamId, search: trimmedBundleId });
        const match = existing.find((appId) => appId.bundleId === trimmedBundleId);
        if (match) {
          appIdId = match.appIdId;
          log('Bundle ID already registered', trimmedBundleId);
        } else {
          const created = await createAppleBundleID({
            relay,
            teamId,
            bundleId: trimmedBundleId,
            name: trimmedAppName || undefined,
          });
          appIdId = created.appIdId;
          log('Bundle ID created', trimmedBundleId);
        }
      }

      // Certificates. The ensure helpers reuse the stored p12 whenever its
      // certificate is still on the team, so re-running Connect is cheap.
      let distributionCertificate: EnsureAppleCertificateResult | undefined;
      await run('distributionCertificate', async () => {
        const result = await ensureAppleCertificateSecret({
          relay,
          teamId,
          secretStore,
          certificateKind: 'distribution',
          commonName: naming.certificateCommonName(teamId),
          log,
        });
        distributionCertificate = result;
        return result.created ? 'Created' : 'Reused existing';
      });

      const ensureProfile = async (
        profileKind: 'appstore',
        certificateId: string | undefined,
        certificateLabel: string,
        name: string,
      ) => {
        if (!certificateId) {
          throw new Error(`Select the ${certificateLabel} action too; the profile must reference it.`);
        }
        // Reuse a portal profile with our name so repeated Connect runs don't
        // pile up duplicates (Apple rejects duplicate profile names anyway).
        const profiles = await listAppleProfiles({ relay, teamId, profileKind, bundleId: trimmedBundleId });
        const existing = profiles.find((profile) => profile.name === name);
        let profileId = existing?.profileId;
        if (!profileId) {
          const created = await createAppleProfile({
            relay,
            teamId,
            profileKind,
            bundleId: trimmedBundleId,
            appIdId,
            certificateIds: [certificateId],
            name,
          });
          profileId = created.profileId;
        }
        await saveAppleProfileSecret({ relay, teamId, profileId, secretStore, log });
        return existing ? 'Reused existing' : 'Created';
      };

      await run('appStoreProfile', () =>
        ensureProfile(
          'appstore',
          distributionCertificate?.certificateId,
          'distribution certificate',
          naming.appStoreProfileName(trimmedBundleId),
        ),
      );

      // App Store Connect rides the same session but carries its own active
      // provider; point it at the selected team once before the iris calls.
      const providerId = selectedTeam?.providerId;
      if (selectedActions.has('appRecord') || selectedActions.has('apiKey')) {
        if (providerId) await switchAppStoreConnectProvider({ relay, providerId });
      }
      let ascAppId: string | undefined;
      await run('appRecord', async () => {
        const result = await ensureAppStoreConnectApp({
          relay,
          bundleId: trimmedBundleId,
          name: trimmedAppName,
        });
        ascAppId = result.app.id;
        return result.created ? 'Created' : 'Reused existing';
      });
      await run('apiKey', async () => {
        const result = await ensureAppStoreConnectApiKeySecret({
          relay,
          teamId,
          secretStore,
          nickname: naming.apiKeyNickname,
          // ADMIN so the key covers everything the publisher may need
          // beyond uploads: sales reports, analytics, metadata edits. The
          // default APP_MANAGER role cannot read sales reports.
          roles: ['ADMIN'],
          log,
        });
        return result.created ? 'Created' : 'Reused existing';
      });

      // --- Device-install credentials ---------------------------------------
      // The remaining actions prepare what the device-install example needs:
      // a development certificate for WebUSB signing, and ad-hoc/development
      // profiles bound to the team's registered devices. Device-bound
      // profiles must list every device they cover, so they are created
      // against the currently registered set; the device-install example
      // reuses these secrets and only asks for an Apple sign-in when an
      // iPhone is not covered yet.
      let developmentCertificate: EnsureAppleCertificateResult | undefined;
      await run('developmentCertificate', async () => {
        const result = await ensureAppleCertificateSecret({
          relay,
          teamId,
          secretStore,
          certificateKind: 'development',
          commonName: naming.certificateCommonName(teamId),
          log,
        });
        developmentCertificate = result;
        return result.created ? 'Created' : 'Reused existing';
      });

      const devices =
        selectedActions.has('adHocProfile') || selectedActions.has('developmentProfile') ?
          (await listAppleDevices({ relay, teamId })).filter((device) =>
            ['iphone', 'ipad'].includes((device.deviceClass ?? '').toLowerCase()),
          )
        : [];

      const ensureDeviceProfile = async (
        profileKind: 'adhoc' | 'development',
        certificate: EnsureAppleCertificateResult | undefined,
        certificateLabel: string,
        name: string,
      ) => {
        if (!certificate) {
          throw new Error(`Select the ${certificateLabel} action too; the profile must reference it.`);
        }
        if (devices.length === 0) {
          return {
            skipped:
              'No iPhones registered on the team yet; the device-install example registers them on first use.',
          };
        }
        const countNote = `${devices.length} device${devices.length === 1 ? '' : 's'}`;
        const profiles = await listAppleProfiles({ relay, teamId, profileKind, bundleId: trimmedBundleId });
        const existingId = profiles.find((profile) => profile.name === name)?.profileId;
        if (existingId) {
          // Reuse the portal profile only while it still references our
          // certificate and covers every registered device; otherwise
          // replace it, since Apple offers no in-place update here.
          const downloaded = await downloadAppleProfile({ relay, teamId, profileId: existingId });
          const info =
            downloaded.rawBodyBase64 ? parseProvisioningProfileBase64(downloaded.rawBodyBase64) : undefined;
          const serial = certificate.secret.data.serialNumber;
          const usable =
            info !== undefined &&
            !!serial &&
            info.certificateSerialNumbers.includes(serial) &&
            devices.every((device) => profileContainsDevice(info, device.deviceNumber)) &&
            isUnexpired(info.expirationDate);
          if (usable) {
            await saveAppleProfileSecret({ relay, teamId, profileId: existingId, secretStore, log });
            return `Reused existing (${countNote})`;
          }
          await deleteAppleProfile({ relay, teamId, profileId: existingId });
          log('Replacing a stale device profile', name);
        }
        const created = await createAppleProfile({
          relay,
          teamId,
          profileKind,
          bundleId: trimmedBundleId,
          appIdId,
          certificateIds: [certificate.certificateId],
          deviceIds: devices.map((device) => device.deviceId).filter((id): id is string => !!id),
          name,
        });
        await saveAppleProfileSecret({ relay, teamId, profileId: created.profileId, secretStore, log });
        return `${existingId ? 'Recreated' : 'Created'} (${countNote})`;
      };

      await run('adHocProfile', () =>
        ensureDeviceProfile(
          'adhoc',
          distributionCertificate,
          'distribution certificate',
          naming.adHocProfileName(trimmedBundleId),
        ),
      );
      await run('developmentProfile', () =>
        ensureDeviceProfile(
          'development',
          developmentCertificate,
          'development certificate',
          naming.developmentProfileName(trimmedBundleId),
        ),
      );

      const established: Connection = {
        teamId,
        bundleId: trimmedBundleId,
        appName: trimmedAppName,
        ascAppId,
      };
      setConnection(established);
      localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(established));
      log('Connect complete', `${teamId} / ${trimmedBundleId}`);
    } catch (error) {
      onError(errorMessage(error, 'Connect failed'));
    } finally {
      setBusy(undefined);
    }
  }, [
    appName,
    bundleId,
    bundleIdChoice,
    log,
    onError,
    relay,
    secretStore,
    selectedActions,
    selectedTeam,
    setActionState,
    teamId,
  ]);

  const disconnect = useCallback(() => {
    localStorage.removeItem(CONNECTION_STORAGE_KEY);
    setConnection(undefined);
    setActionStates({});
    setTeams([]);
    void appleLogin.close();
  }, [appleLogin]);

  const publishReady = useMemo(() => connection !== undefined, [connection]);

  return {
    busy,
    // The scoped-token session against Limrun's registry; sign-in waits
    // for it. Exposed so the app can read backend-advertised defaults
    // (e.g. the secrets directory).
    registrySession,
    relayReady: registrySession !== undefined,
    // Apple login
    appleLogin,
    appleAccount,
    setAppleAccount,
    applePassword,
    setApplePassword,
    twoFactorCode,
    setTwoFactorCode,
    signIn,
    submitTwoFactor,
    loggedIn,
    // Team + inputs
    teams,
    selectedTeamId,
    setSelectedTeamId,
    teamId,
    bundleId,
    setBundleId,
    bundleIdChoice,
    setBundleIdChoice,
    portalAppIds,
    bundleIdsLoading,
    appName,
    setAppName,
    // Checklist
    selectedActions,
    toggleAction,
    actionStates,
    confirm,
    // Result
    connection,
    publishReady,
    disconnect,
  };
}
