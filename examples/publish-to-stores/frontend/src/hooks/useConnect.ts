// The Connect phase: a one-time flow that signs into Apple, resolves the
// team and bundle ID, and materializes everything a publish, and
// optionally the device-install example, later needs: certificates,
// provisioning profiles, the App Store Connect app record and an App
// Store Connect API key — into the backend's secret store. Read
// top-to-bottom it doubles as a reference for the `@limrun/apple-auth`
// APIs.
import { useEffect, useState } from 'react';
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
  type SigningSecretMetadata,
  type SigningSecretStore,
} from '@limrun/apple-auth';
import { useAppleIDLogin } from '@limrun/apple-auth/react';
import { naming } from '../config';
import { errorMessage, fetchRegistrySession, type RegistrySession, type SigningMode } from '../lib/backend';

/**
 * The deselectable actions of the Connect checklist. The bundle ID itself is
 * always ensured because every profile depends on it. The app record and API
 * key cover publishing; the remaining actions prepare signing material for
 * the device-install example's QR code and WebUSB installs.
 */
export const CONNECT_ACTIONS = [
  {
    id: 'distributionCertificate',
    label: 'App distribution certificate',
    description: 'Required for manual App Store signing; also signs ad-hoc device installs.',
  },
  {
    id: 'appStoreProfile',
    label: 'App Store provisioning profile',
    description: 'Required for manual TestFlight and App Store signing.',
  },
  {
    id: 'appRecord',
    label: 'App Store Connect app record',
    description: 'Required before the first upload of a new bundle ID.',
  },
  {
    id: 'apiKey',
    label: 'App Store Connect API key',
    description: 'Authenticates uploads and, in cloud mode, signing.',
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

const REQUIRED_ACTIONS: Record<SigningMode, readonly ConnectActionId[]> = {
  cloud: ['appRecord', 'apiKey'],
  manual: ['distributionCertificate', 'appStoreProfile', 'appRecord', 'apiKey'],
};

function requiredActions(signingMode: SigningMode): Set<ConnectActionId> {
  return new Set(REQUIRED_ACTIONS[signingMode]);
}

export type ActionStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error';

export type ActionState = { status: ActionStatus; note?: string };

export type Connection = {
  teamId: string;
  bundleId: string;
  appName: string;
  signingMode: SigningMode;
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

/**
 * Whether a returning user is still connected: both modes need an App Store
 * Connect API key; manual signing additionally needs the certificate and
 * provisioning profile maintained in the secret store.
 */
async function storeHoldsConnectionSecrets(
  secretStore: SigningSecretStore,
  secrets: SigningSecretMetadata[],
  stored: Connection,
): Promise<boolean> {
  const has = (type: string, name: string) =>
    secrets.some((secret) => secret.type === type && secret.name === name);
  const hasApiKey = has(
    APP_STORE_CONNECT_API_KEY_SECRET_TYPE,
    appStoreConnectApiKeySecretName(stored.teamId),
  );
  if (stored.signingMode === 'cloud') return hasApiKey;
  if (!hasApiKey) return false;
  const certificate = await secretStore.get(
    APPLE_CERTIFICATE_SECRET_TYPE,
    appleCertificateSecretName(stored.teamId, 'DISTRIBUTION'),
  );
  if (!certificate?.data.certificateP12Base64 || !isUnexpired(certificate.data.expirationDate)) return false;
  const profileMetadata = secrets.filter(
    (secret) =>
      secret.type === APPLE_PROVISIONING_PROFILE_SECRET_TYPE && secret.name.startsWith(`${stored.teamId}/`),
  );
  const profiles = await Promise.all(
    profileMetadata.map((secret) => secretStore.get(APPLE_PROVISIONING_PROFILE_SECRET_TYPE, secret.name)),
  );
  return profiles.some(
    (profile) =>
      profile?.data.teamID === stored.teamId &&
      profile.data.bundleIDs?.split(',').includes(stored.bundleId) &&
      !profile.data.deviceIDs &&
      isUnexpired(profile.data.expirationDate),
  );
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
  const [signingMode, setSigningMode] = useState<SigningMode>('cloud');
  const [selectedActions, setSelectedActions] = useState<Set<ConnectActionId>>(() =>
    requiredActions('cloud'),
  );
  const [actionStates, setActionStates] = useState<Partial<Record<ConnectActionId, ActionState>>>({});
  const [connection, setConnection] = useState<Connection>();

  const selectedTeam = teams.find((team) => team.teamId === selectedTeamId);
  const teamId = selectedTeam?.teamId;
  const relay = appleLogin.session?.relay;
  const loggedIn = appleLogin.status === 'authenticated' && !!relay;

  // Restore the previous session's connection, but only while its secrets
  // are still in the store.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const raw = localStorage.getItem(CONNECTION_STORAGE_KEY);
      if (!raw) return;
      let stored: Connection;
      try {
        stored = JSON.parse(raw) as Connection;
        // Connections saved before the selector existed used cloud signing.
        stored.signingMode ??= 'cloud';
      } catch {
        localStorage.removeItem(CONNECTION_STORAGE_KEY);
        return;
      }
      try {
        if (await storeHoldsConnectionSecrets(secretStore, await secretStore.list(), stored)) {
          if (!cancelled) {
            setConnection(stored);
            setBundleId(stored.bundleId);
            setAppName(stored.appName);
            setSigningMode(stored.signingMode);
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

  /**
   * Existing bundle IDs on the portal for the team, so the user can pick
   * one instead of registering a new one. Wildcard app IDs (com.acme.*)
   * are excluded — they cannot carry App Store profiles or app records.
   * Runs when the teams load and when the user switches teams, instead of
   * as an effect watching the selection.
   */
  async function loadBundleIds(relayClient: AppleRelayWebSocketClient, team: AppleTeam) {
    setPortalAppIds([]);
    setBundleIdChoice(NEW_BUNDLE_ID);
    setBundleIdsLoading(true);
    try {
      const appIds = await listAppleBundleIDs({ relay: relayClient, teamId: team.teamId });
      const usable = appIds.filter((appId) => !appId.bundleId.includes('*'));
      setPortalAppIds(usable);
      // A bundle ID restored from a previous session that already exists
      // on the portal is preselected instead of leaving the "register
      // new" input filled.
      const restored = bundleId.trim();
      if (restored && usable.some((appId) => appId.bundleId === restored)) {
        setBundleIdChoice(restored);
        await prefillAppName(relayClient, team, restored);
      }
    } catch (error) {
      onError(errorMessage(error, 'Could not list the existing bundle IDs'));
    } finally {
      setBundleIdsLoading(false);
    }
  }

  function selectTeam(nextTeamId: string) {
    setSelectedTeamId(nextTeamId);
    const team = teams.find((candidate) => candidate.teamId === nextTeamId);
    if (relay && team) void loadBundleIds(relay, team);
  }

  /**
   * Prefills the app name from the App Store Connect app record when an
   * existing bundle ID is selected — that name is the one shown on the App
   * Store. The Developer Portal registration name is deliberately not
   * used: tools often register bundle IDs under generated names like
   * "appexamplemyapp <hash>". Without an app record the field is left for
   * the user to fill. Still editable afterwards.
   */
  async function prefillAppName(
    relayClient: AppleRelayWebSocketClient,
    team: AppleTeam | undefined,
    chosenBundleId: string,
  ) {
    try {
      if (team?.providerId) {
        await switchAppStoreConnectProvider({ relay: relayClient, providerId: team.providerId });
      }
      const app = await findAppStoreConnectApp({ relay: relayClient, bundleId: chosenBundleId });
      if (app?.name) setAppName(app.name);
    } catch {
      // No App Store Connect access or no app record yet; the user
      // types the name themselves.
    }
  }

  function selectBundleId(choice: string) {
    setBundleIdChoice(choice);
    if (choice !== NEW_BUNDLE_ID && relay) void prefillAppName(relay, selectedTeam, choice);
  }

  function toggleAction(id: ConnectActionId) {
    if (requiredActions(signingMode).has(id)) return;
    setSelectedActions((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectSigningMode(mode: SigningMode) {
    setSigningMode(mode);
    // Start each mode with exactly its publish requirements. Device-install
    // credentials remain opt-in and can be selected afterwards.
    setSelectedActions(requiredActions(mode));
    setActionStates({});
  }

  // --- Step 1: Apple ID login -----------------------------------------------

  async function loadTeams(relayClient: AppleRelayWebSocketClient) {
    // finalize() fetches the account session Apple requires before the
    // provisioning endpoints work.
    await appleLogin.finalize().catch(() => undefined);
    const loaded = await listAppleTeams({ relay: relayClient });
    setTeams(loaded);
    setSelectedTeamId(loaded[0]?.teamId ?? '');
    log('Apple teams loaded', String(loaded.length));
    if (loaded[0]) await loadBundleIds(relayClient, loaded[0]);
  }

  async function signIn() {
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
  }

  async function submitTwoFactor() {
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
  }

  // --- Step 2: run the checklist --------------------------------------------

  function setActionState(id: ConnectActionId, state: ActionState) {
    setActionStates((current) => ({ ...current, [id]: state }));
  }

  async function confirm() {
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
      // Filled in by the action below; stays undefined when it is
      // deselected, which the profile actions that need it turn into an
      // error of their own.
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

      await run('appStoreProfile', async () => {
        const certificateId = distributionCertificate?.certificateId;
        if (!certificateId) {
          throw new Error('Manual signing requires the distribution certificate action.');
        }
        const name = naming.appStoreProfileName(trimmedBundleId);
        const profiles = await listAppleProfiles({
          relay,
          teamId,
          profileKind: 'appstore',
          bundleId: trimmedBundleId,
        });
        const existingId = profiles.find((profile) => profile.name === name)?.profileId;
        if (existingId) {
          const downloaded = await downloadAppleProfile({ relay, teamId, profileId: existingId });
          const info =
            downloaded.rawBodyBase64 ? parseProvisioningProfileBase64(downloaded.rawBodyBase64) : undefined;
          const serial = distributionCertificate?.secret.data.serialNumber;
          const usable =
            info !== undefined &&
            !!serial &&
            info.certificateSerialNumbers.includes(serial) &&
            isUnexpired(info.expirationDate);
          if (usable) {
            await saveAppleProfileSecret({ relay, teamId, profileId: existingId, secretStore, log });
            return 'Reused existing';
          }
          await deleteAppleProfile({ relay, teamId, profileId: existingId });
          if (info?.uuid) {
            await secretStore.delete(APPLE_PROVISIONING_PROFILE_SECRET_TYPE, `${teamId}/${info.uuid}`);
          }
          log('Replacing a stale App Store profile', name);
        }
        const created = await createAppleProfile({
          relay,
          teamId,
          profileKind: 'appstore',
          bundleId: trimmedBundleId,
          appIdId,
          certificateIds: [certificateId],
          name,
        });
        await saveAppleProfileSecret({ relay, teamId, profileId: created.profileId, secretStore, log });
        return existingId ? 'Recreated' : 'Created';
      });

      // App Store Connect rides the same session but carries its own active
      // provider; point it at the selected team once before the iris calls.
      const providerId = selectedTeam?.providerId;
      if (selectedActions.has('appRecord') || selectedActions.has('apiKey')) {
        if (providerId) await switchAppStoreConnectProvider({ relay, providerId });
      }
      // Filled in by the app record action; lands in the stored Connection
      // so the UI can link to the app's App Store Connect page.
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
      // Filled in by the action below, read by the development profile action.
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
        signingMode,
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
  }

  function disconnect() {
    localStorage.removeItem(CONNECTION_STORAGE_KEY);
    setConnection(undefined);
    setActionStates({});
    setTeams([]);
    setSelectedTeamId('');
    setPortalAppIds([]);
    setBundleIdChoice(NEW_BUNDLE_ID);
    setSigningMode('cloud');
    setSelectedActions(requiredActions('cloud'));
    void appleLogin.close();
  }

  const publishReady = connection !== undefined;

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
    selectTeam,
    teamId,
    bundleId,
    setBundleId,
    bundleIdChoice,
    selectBundleId,
    portalAppIds,
    bundleIdsLoading,
    appName,
    setAppName,
    signingMode,
    selectSigningMode,
    // Checklist
    requiredActions: requiredActions(signingMode),
    visibleActions: CONNECT_ACTIONS.filter(
      (action) => signingMode === 'manual' || action.id !== 'appStoreProfile',
    ),
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
