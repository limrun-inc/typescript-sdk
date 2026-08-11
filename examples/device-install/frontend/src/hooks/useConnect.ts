// Ad-hoc signing setup for QR/OTA installation. On load the stored secrets
// are checked first: when a distribution certificate and an ad-hoc profile
// for the connection already exist, no Apple sign-in is needed at all.
// Sign-in is required only to create missing material or to register a new
// device into the profile.
import { useEffect, useRef, useState } from 'react';
import {
  APPLE_CERTIFICATE_SECRET_TYPE,
  APPLE_PROVISIONING_PROFILE_SECRET_TYPE,
  appleCertificateSecretName,
  createAppleBundleID,
  createAppleProfile,
  ensureAppleCertificateSecret,
  listAppleBundleIDs,
  listAppleDevices,
  listAppleTeams,
  parseProvisionedDevices,
  registerAppleDevice,
  saveAppleProfileSecret,
  type AppleBundleID,
  type AppleRelayWebSocketClient,
  type AppleTeam,
  type SigningSecret,
  type SigningSecretStore,
} from '@limrun/apple-auth';
import { useAppleIDLogin } from '@limrun/apple-auth/react';
import { naming } from '../config';
import { errorMessage, fetchRegistrySession, type RegistrySession } from '../lib/backend';

export type Connection = {
  teamId: string;
  bundleId: string;
  appName: string;
};

export type SigningState = {
  status: 'idle' | 'checking' | 'ready' | 'missing';
  certificateOk: boolean;
  profileCount: number;
  note?: string;
};

export type RegisteredDevice = {
  /** Normalized (uppercase hex) UDID. */
  udid: string;
  name?: string;
  /** Whether a stored ad-hoc profile already lets this device install the app. */
  covered: boolean;
};

export type DeviceEnrollmentState = {
  status: 'idle' | 'checking' | 'needs-login' | 'ready' | 'error';
  deviceUDID?: string;
  note?: string;
};

type ConnectContext = {
  secretStore: SigningSecretStore;
  log: (message: string, detail?: string) => void;
  onError: (message?: string) => void;
};

const CONNECTION_STORAGE_KEY = 'device-install.connection';
export const NEW_BUNDLE_ID = '__new__';

function restoreConnection(): Connection | undefined {
  const raw = localStorage.getItem(CONNECTION_STORAGE_KEY);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Connection;
  } catch {
    localStorage.removeItem(CONNECTION_STORAGE_KEY);
    return undefined;
  }
}

function normalizeUDID(value?: string) {
  return (value ?? '').replace(/[^a-fA-F0-9]/g, '').toUpperCase();
}

function commaSeparated(value?: string) {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function isUnexpired(expirationDate?: string) {
  if (!expirationDate) return true;
  const expiresAt = Date.parse(expirationDate);
  return Number.isNaN(expiresAt) || expiresAt > Date.now();
}

/**
 * Whether a stored provisioning profile is the ad-hoc signing material for
 * the connection: same team, binds the bundle ID, references the
 * distribution certificate, and neither has expired. Device coverage is
 * judged separately from the profile's device list.
 */
function profileMatchesConnection(
  profile: SigningSecret | undefined,
  certificate: SigningSecret | undefined,
  connection: Connection,
): boolean {
  return (
    profile?.data.teamID === connection.teamId &&
    commaSeparated(profile.data.bundleIDs).includes(connection.bundleId) &&
    !!certificate?.data.serialNumber &&
    commaSeparated(profile.data.certificateSerialNumbers).includes(certificate.data.serialNumber) &&
    isUnexpired(certificate.data.expirationDate) &&
    isUnexpired(profile.data.expirationDate)
  );
}

export type ConnectController = ReturnType<typeof useConnect>;

export function useConnect({ secretStore, log, onError }: ConnectContext) {
  const [busy, setBusy] = useState<string>();
  const [registrySession, setRegistrySession] = useState<RegistrySession>();
  const [appleAccount, setAppleAccount] = useState('');
  const [applePassword, setApplePassword] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [teams, setTeams] = useState<AppleTeam[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState('');
  // A returning user's connection restores synchronously from
  // localStorage; the bundle ID and app name fields seed from it.
  const [connection, setConnection] = useState<Connection | undefined>(restoreConnection);
  const [bundleId, setBundleId] = useState(connection?.bundleId ?? '');
  const [bundleIdChoice, setBundleIdChoice] = useState(NEW_BUNDLE_ID);
  const [portalAppIds, setPortalAppIds] = useState<AppleBundleID[]>([]);
  const [bundleIdsLoading, setBundleIdsLoading] = useState(false);
  const [appName, setAppName] = useState(connection?.appName ?? '');
  const [signing, setSigning] = useState<SigningState>({
    status: 'idle',
    certificateOk: false,
    profileCount: 0,
  });
  const [devices, setDevices] = useState<RegisteredDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<RegisteredDevice>();
  const [deviceEnrollment, setDeviceEnrollment] = useState<DeviceEnrollmentState>({ status: 'idle' });

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
  const relay = appleLogin.session?.relay;
  const loggedIn = appleLogin.status === 'authenticated' && !!relay;
  const selectedTeam = teams.find((team) => team.teamId === selectedTeamId);
  const teamId = selectedTeam?.teamId;

  /**
   * The stored distribution certificate and the ad-hoc profiles that match
   * the connection. This is the secret-store check the whole flow starts
   * with; it needs no Apple session.
   */
  async function collectSigningMaterial(target: Connection) {
    const certificate = await secretStore.get(
      APPLE_CERTIFICATE_SECRET_TYPE,
      appleCertificateSecretName(target.teamId, 'DISTRIBUTION'),
    );
    const certificateOk =
      !!certificate && !!certificate.data.serialNumber && isUnexpired(certificate.data.expirationDate);
    const profiles: SigningSecret[] = [];
    if (certificateOk) {
      const metadata = (await secretStore.list()).filter(
        (secret) =>
          secret.type === APPLE_PROVISIONING_PROFILE_SECRET_TYPE &&
          secret.name.startsWith(`${target.teamId}/`),
      );
      for (const meta of metadata) {
        const profile = await secretStore.get(APPLE_PROVISIONING_PROFILE_SECRET_TYPE, meta.name);
        if (profileMatchesConnection(profile, certificate, target)) profiles.push(profile!);
      }
    }
    return { certificate: certificateOk ? certificate : undefined, profiles };
  }

  /**
   * Refreshes the signing summary and the registered-device list. Devices
   * come from the matching profiles' device lists; when an Apple session is
   * open, the team's portal devices are merged in (uncovered until a
   * profile includes them).
   */
  async function refreshSigning(target?: Connection) {
    const active = target ?? connection;
    if (!active) return;
    setSigning((current) => ({ ...current, status: 'checking' }));
    try {
      const { certificate, profiles } = await collectSigningMaterial(active);
      const byUDID = new Map<string, RegisteredDevice>();
      for (const profile of profiles) {
        for (const device of parseProvisionedDevices(profile.data.deviceIDs)) {
          const udid = normalizeUDID(device.udid);
          if (!udid) continue;
          byUDID.set(udid, { udid, name: device.name ?? byUDID.get(udid)?.name, covered: true });
        }
      }
      if (relay && loggedIn) {
        try {
          const portalDevices = await listAppleDevices({ relay, teamId: active.teamId });
          for (const portalDevice of portalDevices) {
            const udid = normalizeUDID(portalDevice.deviceNumber);
            if (!udid || byUDID.has(udid)) continue;
            byUDID.set(udid, { udid, name: portalDevice.name, covered: false });
          }
        } catch (error) {
          log('Could not list portal devices', errorMessage(error, 'unknown error'));
        }
      }
      const nextDevices = [...byUDID.values()].sort((a, b) => a.udid.localeCompare(b.udid));
      setDevices(nextDevices);
      setSelectedDevice((current) => current && byUDID.get(current.udid));
      const ready = !!certificate && profiles.length > 0;
      setSigning({
        status: ready ? 'ready' : 'missing',
        certificateOk: !!certificate,
        profileCount: profiles.length,
        note:
          ready ?
            `Distribution certificate and ${profiles.length} ad-hoc profile${
              profiles.length === 1 ? '' : 's'
            } are stored.`
          : certificate ?
            'Distribution certificate is stored. An ad-hoc profile is created when a device is registered below.'
          : 'No distribution certificate or ad-hoc profile is stored yet. Sign in with Apple so they can be created.',
      });
    } catch (error) {
      setSigning({
        status: 'missing',
        certificateOk: false,
        profileCount: 0,
        note: errorMessage(error, 'Could not check the signing secrets'),
      });
    }
  }

  // The load-time secret-store check: with a restored connection the app
  // starts by looking at what's stored, not by asking for a sign-in. The
  // ref guard makes this a run-once effect without a dependency list.
  const initialSigningChecked = useRef(false);
  useEffect(() => {
    if (initialSigningChecked.current) return;
    initialSigningChecked.current = true;
    if (connection) void refreshSigning(connection);
  });

  /**
   * Existing bundle IDs on the portal for the team, so the user can pick
   * one instead of registering a new one. Wildcard app IDs are excluded.
   * Runs when the teams load and when the user switches teams, instead of
   * as an effect watching the selection.
   */
  async function loadBundleIds(relayClient: AppleRelayWebSocketClient, team: AppleTeam) {
    setPortalAppIds([]);
    setBundleIdChoice(NEW_BUNDLE_ID);
    setBundleIdsLoading(true);
    try {
      const appIds = await listAppleBundleIDs({ relay: relayClient, teamId: team.teamId });
      setPortalAppIds(appIds.filter((appId) => !appId.bundleId.includes('*')));
    } catch (error) {
      onError(errorMessage(error, 'Could not list bundle IDs'));
    } finally {
      setBundleIdsLoading(false);
    }
  }

  function selectTeam(nextTeamId: string) {
    setSelectedTeamId(nextTeamId);
    const team = teams.find((candidate) => candidate.teamId === nextTeamId);
    if (relay && team) void loadBundleIds(relay, team);
  }

  async function loadTeams(relayClient: AppleRelayWebSocketClient) {
    await appleLogin.finalize().catch(() => undefined);
    const loaded = await listAppleTeams({ relay: relayClient });
    setTeams(loaded);
    setSelectedTeamId(loaded[0]?.teamId ?? '');
    log('Apple teams loaded', String(loaded.length));
    // A returning user signing in to extend an existing connection skips
    // the team/bundle forms; refresh the device list with portal data.
    if (connection) {
      void refreshSigning(connection);
      return;
    }
    if (loaded[0]) await loadBundleIds(relayClient, loaded[0]);
  }

  async function signIn() {
    if (!registrySession) return onError('The registry session is not ready; is the backend running?');
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

  async function confirm() {
    if (!relay || !teamId) return onError('Sign in with Apple and select a team first.');
    const chosenBundleId = (bundleIdChoice === NEW_BUNDLE_ID ? bundleId : bundleIdChoice).trim();
    if (!chosenBundleId) return onError('Enter a bundle ID or pick an existing one.');
    onError(undefined);
    setBusy('confirm');
    try {
      const existing = await listAppleBundleIDs({ relay, teamId, search: chosenBundleId });
      if (!existing.some((appId) => appId.bundleId === chosenBundleId)) {
        await createAppleBundleID({
          relay,
          teamId,
          bundleId: chosenBundleId,
          name: appName.trim() || undefined,
        });
        log('Bundle ID created', chosenBundleId);
      } else {
        log('Bundle ID already registered', chosenBundleId);
      }
      // The distribution certificate can be ensured right away; the ad-hoc
      // profile is device-scoped and waits for a registered device.
      await ensureAppleCertificateSecret({
        relay,
        teamId,
        secretStore,
        certificateKind: 'distribution',
        commonName: naming.certificateCommonName(teamId),
        log,
      });
      const established = { teamId, bundleId: chosenBundleId, appName: appName.trim() };
      setConnection(established);
      localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(established));
      await refreshSigning(established);
    } catch (error) {
      onError(errorMessage(error, 'Device installer setup failed'));
    } finally {
      setBusy(undefined);
    }
  }

  /**
   * Makes sure a device is registered on the portal and covered by an
   * ad-hoc profile referencing the stored distribution certificate. Used
   * both for newly plugged-in devices (UDID read over WebUSB) and for
   * portal-listed devices no stored profile covers yet.
   */
  async function prepareDevice(deviceUDID: string, productName: string): Promise<boolean> {
    if (!connection) return false;
    const normalizedUDID = normalizeUDID(deviceUDID);
    if (!normalizedUDID) {
      onError('The iPhone did not report a UDID.');
      return false;
    }
    onError(undefined);
    setDeviceEnrollment({ status: 'checking', deviceUDID: normalizedUDID });
    try {
      const { certificate, profiles } = await collectSigningMaterial(connection);
      const coveringProfile =
        certificate &&
        profiles.find((profile) =>
          parseProvisionedDevices(profile.data.deviceIDs).some(
            (device) => normalizeUDID(device.udid) === normalizedUDID,
          ),
        );
      if (coveringProfile) {
        setDeviceEnrollment({
          status: 'ready',
          deviceUDID: normalizedUDID,
          note: 'Stored ad-hoc signing already covers this iPhone.',
        });
        await refreshSigning(connection);
        setSelectedDevice({ udid: normalizedUDID, name: productName, covered: true });
        return true;
      }

      if (!relay || !loggedIn) {
        setDeviceEnrollment({
          status: 'needs-login',
          deviceUDID: normalizedUDID,
          note: 'Sign in with Apple to register this iPhone and create its ad-hoc profile.',
        });
        return false;
      }

      setBusy('device-enrollment');
      let portalDevices = await listAppleDevices({ relay, teamId: connection.teamId });
      let portalDevice = portalDevices.find(
        (device) => normalizeUDID(device.deviceNumber) === normalizedUDID,
      );
      if (!portalDevice) {
        await registerAppleDevice({
          relay,
          teamId: connection.teamId,
          deviceUDID: normalizedUDID,
          name: naming.deviceName(productName, normalizedUDID),
        });
        portalDevices = await listAppleDevices({ relay, teamId: connection.teamId });
        portalDevice = portalDevices.find((device) => normalizeUDID(device.deviceNumber) === normalizedUDID);
        log('Registered iPhone with Apple', normalizedUDID);
      }
      if (!portalDevice?.deviceId) throw new Error('Apple did not return a device ID after registration.');

      const appIds = await listAppleBundleIDs({
        relay,
        teamId: connection.teamId,
        search: connection.bundleId,
      });
      const appIdId = appIds.find((candidate) => candidate.bundleId === connection.bundleId)?.appIdId;
      if (!appIdId) throw new Error(`Could not resolve ${connection.bundleId} on the Developer Portal.`);

      const signingCertificate = await ensureAppleCertificateSecret({
        relay,
        teamId: connection.teamId,
        secretStore,
        certificateKind: 'distribution',
        commonName: naming.certificateCommonName(connection.teamId),
        log,
      });
      const created = await createAppleProfile({
        relay,
        teamId: connection.teamId,
        profileKind: 'adhoc',
        bundleId: connection.bundleId,
        appIdId,
        certificateIds: [signingCertificate.certificateId],
        deviceIds: [portalDevice.deviceId],
        name: naming.profileName(connection.bundleId, normalizedUDID),
      });
      await saveAppleProfileSecret({
        relay,
        teamId: connection.teamId,
        profileId: created.profileId,
        secretStore,
        log,
      });
      setDeviceEnrollment({
        status: 'ready',
        deviceUDID: normalizedUDID,
        note: 'The iPhone is registered and covered by ad-hoc signing.',
      });
      await refreshSigning(connection);
      setSelectedDevice({ udid: normalizedUDID, name: productName, covered: true });
      return true;
    } catch (error) {
      const message = errorMessage(error, 'Could not prepare the iPhone');
      setDeviceEnrollment({ status: 'error', deviceUDID: normalizedUDID, note: message });
      onError(message);
      return false;
    } finally {
      setBusy((current) => (current === 'device-enrollment' ? undefined : current));
    }
  }

  function disconnect() {
    localStorage.removeItem(CONNECTION_STORAGE_KEY);
    setConnection(undefined);
    setSigning({ status: 'idle', certificateOk: false, profileCount: 0 });
    setDevices([]);
    setSelectedDevice(undefined);
    setDeviceEnrollment({ status: 'idle' });
    setTeams([]);
    setSelectedTeamId('');
    setPortalAppIds([]);
    setBundleIdChoice(NEW_BUNDLE_ID);
    void appleLogin.close();
  }

  return {
    busy,
    // Exposed so the app can read backend-advertised defaults (e.g. the
    // secrets directory).
    registrySession,
    relayReady: registrySession !== undefined,
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
    teams,
    selectedTeamId,
    selectTeam,
    bundleId,
    setBundleId,
    bundleIdChoice,
    setBundleIdChoice,
    portalAppIds,
    bundleIdsLoading,
    appName,
    setAppName,
    confirm,
    connection,
    signing,
    refreshSigning,
    devices,
    selectedDevice,
    selectDevice: setSelectedDevice,
    deviceEnrollment,
    prepareDevice,
    disconnect,
  };
}
