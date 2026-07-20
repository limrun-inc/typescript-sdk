// The Connect phase: a one-time flow that signs into Apple, resolves the
// team and bundle ID, and materializes everything a publish later needs —
// certificates, provisioning profiles, the App Store Connect app record and
// an App Store Connect API key — into the backend's secret store. Read
// top-to-bottom it doubles as a reference for the `@limrun/ui` publishing
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
  ensureAppleCertificateSecret,
  ensureAppStoreConnectApiKeySecret,
  ensureAppStoreConnectApp,
  findAppStoreConnectApp,
  listAppleBundleIDs,
  listAppleDevices,
  listAppleProfiles,
  listAppleTeams,
  saveAppleProfileSecret,
  switchAppStoreConnectProvider,
  type AppleDeveloperPortalAppID,
  type AppleDeveloperPortalTeam,
  type AppleRelayWebSocketClient,
  type SigningSecretStore,
} from '@limrun/ui/apple';
import { useAppleIDLogin } from '@limrun/ui/apple/react';
import { BACKEND_URL, naming } from '../config';
import {
  appIdBundleId,
  appIdIdentifier,
  appleTeamProviderId,
  appleTeamSelectionId,
  errorMessage,
  stringField,
} from '../lib/apple';

/**
 * The deselectable actions of the Connect checklist. The bundle ID itself is
 * always ensured because every profile depends on it.
 */
export const CONNECT_ACTIONS = [
  {
    id: 'developmentCertificate',
    label: 'Development certificate',
    description: 'Signs development builds (WebUSB installs).',
  },
  {
    id: 'distributionCertificate',
    label: 'Distribution certificate',
    description: 'Signs ad-hoc, TestFlight and App Store builds.',
  },
  {
    id: 'developmentProfile',
    label: 'Development provisioning profile',
    description: 'For WebUSB installs to registered devices.',
  },
  {
    id: 'adhocProfile',
    label: 'Ad-hoc provisioning profile',
    description: 'For QR installs to registered devices.',
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
   * action runs. Used to link to the app's TestFlight and App Store pages
   * after a publish.
   */
  ascAppId?: string;
};

const CONNECTION_STORAGE_KEY = 'publish-to-stores.connection';

/** Sentinel for the bundle ID picker's "register a new one" option. */
export const NEW_BUNDLE_ID = '__new__';

type ConnectContext = {
  secretStore: SigningSecretStore;
  log: (message: string, detail?: string) => void;
  onError: (message?: string) => void;
};

export type ConnectController = ReturnType<typeof useConnect>;

export function useConnect({ secretStore, log, onError }: ConnectContext) {
  const [busy, setBusy] = useState<string>();

  // The Apple relay rides the example backend, which pipes the WebSocket to
  // Limrun's registry with the API key attached server-side — the key never
  // reaches the browser. No Xcode instance is created for Connect; the
  // first one appears when a publish runs the CLI.
  const appleLogin = useAppleIDLogin({ registryApiUrl: BACKEND_URL });
  const [appleAccount, setAppleAccount] = useState('');
  const [applePassword, setApplePassword] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');

  const [teams, setTeams] = useState<AppleDeveloperPortalTeam[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [bundleId, setBundleId] = useState('');
  const [bundleIdChoice, setBundleIdChoice] = useState(NEW_BUNDLE_ID);
  const [portalAppIds, setPortalAppIds] = useState<AppleDeveloperPortalAppID[]>([]);
  const [bundleIdsLoading, setBundleIdsLoading] = useState(false);
  const [appName, setAppName] = useState('');
  const [selectedActions, setSelectedActions] = useState<Set<ConnectActionId>>(
    () => new Set(CONNECT_ACTIONS.map((action) => action.id)),
  );
  const [actionStates, setActionStates] = useState<Partial<Record<ConnectActionId, ActionState>>>({});
  const [connection, setConnection] = useState<Connection>();

  const selectedTeam = teams.find((team) => appleTeamSelectionId(team) === selectedTeamId);
  const teamId = appleTeamSelectionId(selectedTeam);
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
        if (
          has(APPLE_CERTIFICATE_SECRET_TYPE, appleCertificateSecretName(stored.teamId, 'DISTRIBUTION')) &&
          has(APP_STORE_CONNECT_API_KEY_SECRET_TYPE, appStoreConnectApiKeySecretName(stored.teamId)) &&
          hasProfile
        ) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        setPortalAppIds(appIds.filter((appId) => !(appIdBundleId(appId) ?? '').includes('*')));
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
    if (trimmed && portalAppIds.some((appId) => appIdBundleId(appId) === trimmed)) {
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
        const providerId = appleTeamProviderId(selectedTeam);
        if (providerId) await switchAppStoreConnectProvider({ relay, providerId });
        const app = await findAppStoreConnectApp({ relay, bundleId: bundleIdChoice });
        const name = stringField(app?.attributes as Record<string, unknown> | undefined, 'name');
        if (!cancelled && name) setAppName(name);
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
      setSelectedTeamId(loaded.map(appleTeamSelectionId).find(Boolean) ?? '');
      log('Apple teams loaded', String(loaded.length));
    },
    [appleLogin, log],
  );

  const signIn = useCallback(async () => {
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
  }, [appleAccount, applePassword, appleLogin, loadTeams, onError]);

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

    const run = async (id: ConnectActionId, action: () => Promise<string | undefined>) => {
      if (!selectedActions.has(id)) return;
      setActionState(id, { status: 'running' });
      try {
        const note = await action();
        setActionState(id, { status: 'done', note });
      } catch (error) {
        setActionState(id, { status: 'error', note: errorMessage(error, 'Failed') });
        throw error;
      }
    };
    const skip = (id: ConnectActionId, note: string) => {
      if (selectedActions.has(id)) setActionState(id, { status: 'skipped', note });
    };

    try {
      // Bundle ID: every profile and the app record hang off it, so it is
      // ensured unconditionally rather than being a checklist item.
      let appIdId: string | undefined;
      {
        const existing = await listAppleBundleIDs({ relay, teamId, search: trimmedBundleId });
        const match = existing.find((appId) => appIdBundleId(appId) === trimmedBundleId);
        if (match) {
          appIdId = appIdIdentifier(match);
          log('Bundle ID already registered', trimmedBundleId);
        } else {
          const created = await createAppleBundleID({
            relay,
            teamId,
            bundleId: trimmedBundleId,
            name: trimmedAppName || undefined,
          });
          appIdId = stringField(created, 'appIdId') ?? stringField(created, 'appId');
          log('Bundle ID created', trimmedBundleId);
        }
        if (!appIdId) throw new Error('Could not resolve the bundle ID record on the portal.');
      }

      // Certificates. The ensure helpers reuse the stored p12 whenever its
      // certificate is still on the team, so re-running Connect is cheap.
      let developmentCertificateId: string | undefined;
      await run('developmentCertificate', async () => {
        const result = await ensureAppleCertificateSecret({
          relay,
          teamId,
          secretStore,
          certificateKind: 'development',
          commonName: naming.certificateCommonName(teamId),
          log,
        });
        developmentCertificateId = result.certificateId;
        return result.created ? 'Created' : 'Reused existing';
      });
      let distributionCertificateId: string | undefined;
      await run('distributionCertificate', async () => {
        const result = await ensureAppleCertificateSecret({
          relay,
          teamId,
          secretStore,
          certificateKind: 'distribution',
          commonName: naming.certificateCommonName(teamId),
          log,
        });
        distributionCertificateId = result.certificateId;
        return result.created ? 'Created' : 'Reused existing';
      });

      // Device-bound profiles need at least one registered device; App Store
      // profiles bind none.
      const devices = await listAppleDevices({ relay, teamId });
      const deviceIds = devices
        .map((device) => device.deviceId)
        .filter((id): id is string => typeof id === 'string' && id !== '');

      const ensureProfile = async (
        profileKind: 'development' | 'adhoc' | 'appstore',
        certificateId: string | undefined,
        certificateLabel: string,
        name: string,
        profileDeviceIds?: string[],
      ) => {
        if (!certificateId) {
          throw new Error(`Select the ${certificateLabel} action too; the profile must reference it.`);
        }
        // Reuse a portal profile with our name so repeated Connect runs don't
        // pile up duplicates (Apple rejects duplicate profile names anyway).
        const profiles = await listAppleProfiles({ relay, teamId, profileKind, bundleId: trimmedBundleId });
        const existing = profiles.find((profile) => stringField(profile, 'name') === name);
        let profileId =
          existing ?
            (stringField(existing, 'provisioningProfileId') ?? stringField(existing, 'profileId'))
          : undefined;
        if (!profileId) {
          const created = await createAppleProfile({
            relay,
            teamId,
            profileKind,
            bundleId: trimmedBundleId,
            appIdId: appIdId!,
            certificateIds: [certificateId],
            deviceIds: profileDeviceIds,
            name,
          });
          profileId = stringField(created, 'provisioningProfileId') ?? stringField(created, 'profileId');
        }
        if (!profileId) throw new Error('Profile creation did not return a profile ID.');
        await saveAppleProfileSecret({ relay, teamId, profileId, secretStore, log });
        return existing ? 'Reused existing' : 'Created';
      };

      if (deviceIds.length === 0) {
        skip('developmentProfile', 'Team has no registered devices; register one first.');
        skip('adhocProfile', 'Team has no registered devices; register one first.');
      } else {
        await run('developmentProfile', () =>
          ensureProfile(
            'development',
            developmentCertificateId,
            'development certificate',
            naming.developmentProfileName(trimmedBundleId),
            deviceIds,
          ),
        );
        await run('adhocProfile', () =>
          ensureProfile(
            'adhoc',
            distributionCertificateId,
            'distribution certificate',
            naming.adHocProfileName(trimmedBundleId),
            deviceIds,
          ),
        );
      }
      await run('appStoreProfile', () =>
        ensureProfile(
          'appstore',
          distributionCertificateId,
          'distribution certificate',
          naming.appStoreProfileName(trimmedBundleId),
        ),
      );

      // App Store Connect rides the same session but carries its own active
      // provider; point it at the selected team once before the iris calls.
      const providerId = appleTeamProviderId(selectedTeam);
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
          log,
        });
        return result.created ? 'Created' : 'Reused existing';
      });

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
