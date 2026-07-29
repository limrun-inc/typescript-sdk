// Apple account setup plus device-specific signing. Connect only chooses the
// team and bundle ID; the selected installation method later determines
// whether development or ad-hoc credentials are created.
import { useEffect, useState } from 'react';
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

export type DeviceEnrollmentState = {
  status: 'idle' | 'checking' | 'needs-login' | 'ready' | 'error';
  deviceUDID?: string;
  profileKind?: 'development' | 'adhoc';
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
 * Whether a stored provisioning profile already lets the connected app be
 * installed on the device: same team, binds the bundle ID, lists the
 * device, references the certificate, and neither profile nor certificate
 * has expired.
 */
function profileCoversDevice(
  profile: SigningSecret | undefined,
  certificate: SigningSecret | undefined,
  connection: Connection,
  normalizedUDID: string,
): boolean {
  return (
    profile?.data.teamID === connection.teamId &&
    commaSeparated(profile.data.bundleIDs).includes(connection.bundleId) &&
    parseProvisionedDevices(profile.data.deviceIDs).some(
      (device) => normalizeUDID(device.udid) === normalizedUDID,
    ) &&
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
      const established = { teamId, bundleId: chosenBundleId, appName: appName.trim() };
      setConnection(established);
      localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(established));
    } catch (error) {
      onError(errorMessage(error, 'Device installer setup failed'));
    } finally {
      setBusy(undefined);
    }
  }

  async function prepareDevice(
    deviceUDID: string,
    productName: string,
    profileKind: 'development' | 'adhoc',
  ) {
    if (!connection) return false;
    const normalizedUDID = normalizeUDID(deviceUDID);
    if (!normalizedUDID) {
      onError('The selected iPhone did not report a UDID.');
      return false;
    }
    onError(undefined);
    setDeviceEnrollment({ status: 'checking', deviceUDID: normalizedUDID, profileKind });
    try {
      const certificateKind = profileKind === 'adhoc' ? 'DISTRIBUTION' : 'DEVELOPMENT';
      const certificate = await secretStore.get(
        APPLE_CERTIFICATE_SECRET_TYPE,
        appleCertificateSecretName(connection.teamId, certificateKind),
      );
      const profileMetadata = (await secretStore.list()).filter(
        (secret) =>
          secret.type === APPLE_PROVISIONING_PROFILE_SECRET_TYPE &&
          secret.name.startsWith(`${connection.teamId}/`),
      );
      for (const metadata of profileMetadata) {
        const profile = await secretStore.get(APPLE_PROVISIONING_PROFILE_SECRET_TYPE, metadata.name);
        if (profileCoversDevice(profile, certificate, connection, normalizedUDID)) {
          setDeviceEnrollment({
            status: 'ready',
            deviceUDID: normalizedUDID,
            profileKind,
            note: `Stored ${profileKind === 'adhoc' ? 'ad-hoc' : 'development'} signing covers this iPhone.`,
          });
          return true;
        }
      }

      if (!relay || !loggedIn) {
        setDeviceEnrollment({
          status: 'needs-login',
          deviceUDID: normalizedUDID,
          profileKind,
          note: 'Sign in with Apple again to register this iPhone and create its signing profile.',
        });
        return false;
      }

      setBusy('device-enrollment');
      let devices = await listAppleDevices({ relay, teamId: connection.teamId });
      let portalDevice = devices.find((device) => normalizeUDID(device.deviceNumber) === normalizedUDID);
      if (!portalDevice) {
        await registerAppleDevice({
          relay,
          teamId: connection.teamId,
          deviceUDID: normalizedUDID,
          name: naming.deviceName(productName, normalizedUDID),
        });
        devices = await listAppleDevices({ relay, teamId: connection.teamId });
        portalDevice = devices.find((device) => normalizeUDID(device.deviceNumber) === normalizedUDID);
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
        certificateKind: profileKind === 'adhoc' ? 'distribution' : 'development',
        commonName: naming.certificateCommonName(connection.teamId),
        log,
      });
      const created = await createAppleProfile({
        relay,
        teamId: connection.teamId,
        profileKind,
        bundleId: connection.bundleId,
        appIdId,
        certificateIds: [signingCertificate.certificateId],
        deviceIds: [portalDevice.deviceId],
        name:
          profileKind === 'adhoc' ?
            naming.qrProfileName(connection.bundleId, normalizedUDID)
          : naming.webUsbProfileName(connection.bundleId, normalizedUDID),
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
        profileKind,
        note: `The iPhone is registered and covered by ${
          profileKind === 'adhoc' ? 'ad-hoc' : 'development'
        } signing.`,
      });
      return true;
    } catch (error) {
      const message = errorMessage(error, 'Could not prepare the selected iPhone');
      setDeviceEnrollment({ status: 'error', deviceUDID: normalizedUDID, profileKind, note: message });
      onError(message);
      return false;
    } finally {
      setBusy((current) => (current === 'device-enrollment' ? undefined : current));
    }
  }

  function disconnect() {
    localStorage.removeItem(CONNECTION_STORAGE_KEY);
    setConnection(undefined);
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
    deviceEnrollment,
    prepareDevice,
    disconnect,
  };
}
