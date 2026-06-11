// A real-device install must be signed. This hook owns everything about
// producing a `StoredSigningAssets` object — either by signing in with an Apple
// ID and letting Limrun mint a certificate + provisioning profile, or by
// importing an uploaded `.p12` + `.mobileprovision`. Keeping it all in one hook
// lets the UI components stay declarative; read top-to-bottom it doubles as a
// reference for the `@limrun/ui` signing APIs.
import { useEffect, useState } from 'react';
import {
  createAppleBundleID,
  createAppleCertificate,
  createAppleProfile,
  downloadAppleCertificate,
  downloadAppleProfile,
  exportAppleCertificateP12,
  generateAppleSigningKeyAndCSR,
  listAppleBundleIDs,
  listAppleCertificates,
  listAppleDevices,
  listAppleProfiles,
  listAppleTeams,
  registerAppleDevice,
} from '@limrun/ui/app-store-relay';
import { useAppleIDLogin } from '@limrun/ui/app-store-relay/react';
import {
  getLatestSigningAssetsWithCertificate,
  importSigningAssetsFromFiles,
  parseProvisioningProfileBase64,
  putAppleGeneratedSigningAssets,
  type StoredSigningAssets,
} from '@limrun/ui/device-build';
import {
  appIdBundleId,
  appIdIdentifier,
  appleTeamSelectionId,
  emptyAppleResources,
  errorMessage,
  sameUDID,
  stringField,
  type AppleResourceState,
} from '../lib/apple';
import type { SigningSource } from '../types';

export type CertificateChoice = 'stored' | 'create';
export type ProfileChoice = 'create' | 'existing';

type SigningContext = {
  apiUrl?: string;
  token?: string;
  /** UDID of the paired iPhone, used to scope the profile to this device. */
  deviceUDID?: string;
  /** Friendly name used when registering the device with Apple. */
  deviceName?: string;
  log: (message: string, detail?: unknown) => void;
  onError: (message?: string) => void;
};

export type SigningController = ReturnType<typeof useSigning>;

export function useSigning({ apiUrl, token, deviceUDID, deviceName, log, onError }: SigningContext) {
  // Shared across both flows.
  const [source, setSource] = useState<SigningSource>('apple');
  const [bundleId, setBundleId] = useState('');
  const [signingAssets, setSigningAssets] = useState<StoredSigningAssets>();
  const [busy, setBusy] = useState<string>();

  // Upload flow.
  const [certificateFile, setCertificateFile] = useState<File>();
  const [provisioningProfileFile, setProvisioningProfileFile] = useState<File>();
  const [certificatePassword, setCertificatePassword] = useState('');

  // Apple ID flow.
  const appleLogin = useAppleIDLogin({ limbuildApiUrl: apiUrl ?? '', token });
  const [appleAccount, setAppleAccount] = useState('');
  const [applePassword, setApplePassword] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [resources, setResources] = useState<AppleResourceState>(emptyAppleResources);
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [selectedAppIdId, setSelectedAppIdId] = useState('');
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>([]);
  const [certificateChoice, setCertificateChoice] = useState<CertificateChoice>('create');
  const [profileChoice, setProfileChoice] = useState<ProfileChoice>('create');
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [storedCertificate, setStoredCertificate] = useState<StoredSigningAssets>();

  // Resolve the developer team id the same way the <select> value is computed.
  const selectedTeam = resources.teams.find((team) => appleTeamSelectionId(team) === selectedTeamId);
  const developerTeamId = appleTeamSelectionId(selectedTeam);
  const selectedProfile = resources.profiles.find(
    (profile) => stringField(profile, 'provisioningProfileId') === selectedProfileId,
  );
  const canUseApple = !!apiUrl && !!appleLogin.session?.appleSessionId && !!developerTeamId;
  const canRegisterDevice = canUseApple && !!deviceUDID;

  // When a team is selected, surface any certificate this browser already
  // created for it. Apple never returns private keys, so only locally stored
  // certs can be reused for signing.
  useEffect(() => {
    let cancelled = false;
    if (!developerTeamId) {
      setStoredCertificate(undefined);
      setCertificateChoice('create');
      return;
    }
    void getLatestSigningAssetsWithCertificate(developerTeamId, 'development').then((assets) => {
      if (cancelled) return;
      setStoredCertificate(assets);
      setCertificateChoice(assets ? 'stored' : 'create');
    });
    return () => {
      cancelled = true;
    };
  }, [developerTeamId]);

  // --- Apple ID login -------------------------------------------------------

  async function signInWithApple() {
    if (!apiUrl) {
      onError('Create a sandbox first.');
      return;
    }
    onError(undefined);
    setBusy('login');
    try {
      const session = await appleLogin.startLogin({ accountName: appleAccount, password: applePassword });
      if (session && !session.requiresTwoFactor) {
        // Clear the password only once login has fully completed; keep it while
        // a two-factor code is still required so the user needn't retype it.
        setApplePassword('');
        await loadAppleTeams(session.appleSessionId);
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
      await appleLogin.submitTwoFactorCode(twoFactorCode);
      setTwoFactorCode('');
      setApplePassword('');
      await loadAppleTeams(appleLogin.session.appleSessionId);
    } catch (error) {
      onError(errorMessage(error, 'Two-factor verification failed'));
    } finally {
      setBusy(undefined);
    }
  }

  async function loadAppleTeams(appleSessionId = appleLogin.session?.appleSessionId) {
    if (!apiUrl || !appleSessionId) return;
    setBusy('teams');
    try {
      await appleLogin.finalize().catch(() => undefined);
      const teams = await listAppleTeams({ apiUrl, token, appleSessionId });
      setResources((current) => ({ ...current, teams }));
      const firstTeamId = teams.map(appleTeamSelectionId).find(Boolean) ?? '';
      setSelectedTeamId(firstTeamId);
      if (firstTeamId) await loadAppleResources(firstTeamId, appleSessionId);
      log('Apple teams loaded', String(teams.length));
    } catch (error) {
      onError(errorMessage(error, 'Failed to load Apple teams'));
    } finally {
      setBusy(undefined);
    }
  }

  // --- Apple Developer Portal resources ------------------------------------

  async function loadAppleResources(
    teamId = developerTeamId,
    appleSessionId = appleLogin.session?.appleSessionId,
  ) {
    if (!apiUrl || !appleSessionId || !teamId) return;
    const base = { apiUrl, token, appleSessionId, teamId };
    const [appIds, devices, certificates, profiles] = await Promise.all([
      listAppleBundleIDs(base),
      listAppleDevices(base),
      listAppleCertificates({ ...base, certificateKind: 'development' }),
      listAppleProfiles({ ...base, profileKind: 'development' }),
    ]);
    setResources((current) => ({ ...current, appIds, devices, certificates, profiles }));

    // Pre-select sensible defaults so the user can usually just hit "Prepare".
    const firstApp = appIds[0];
    setSelectedAppIdId(appIdIdentifier(firstApp) ?? '');
    if (!bundleId.trim() && appIdBundleId(firstApp)) setBundleId(appIdBundleId(firstApp) as string);
    const matchingDevice =
      deviceUDID ? devices.find((device) => sameUDID(device.deviceNumber, deviceUDID)) : undefined;
    const firstDeviceId = matchingDevice?.deviceId ?? devices.find((device) => !!device.deviceId)?.deviceId;
    setSelectedDeviceIds(firstDeviceId ? [firstDeviceId] : []);
    setSelectedProfileId(
      profiles.map((profile) => stringField(profile, 'provisioningProfileId')).find(Boolean) ?? '',
    );
  }

  function selectTeam(value: string) {
    setSelectedTeamId(value);
    const team = resources.teams.find((t) => appleTeamSelectionId(t) === value);
    const teamId = appleTeamSelectionId(team);
    if (teamId) void loadAppleResources(teamId);
  }

  async function createBundleIdResource() {
    if (!canUseApple || !bundleId.trim() || !appleLogin.session || !developerTeamId) return;
    onError(undefined);
    setBusy('bundle');
    try {
      const app = await createAppleBundleID({
        apiUrl: apiUrl!,
        token,
        appleSessionId: appleLogin.session.appleSessionId,
        teamId: developerTeamId,
        bundleId: bundleId.trim(),
      });
      const appIdId = stringField(app, 'appIdId') ?? stringField(app, 'appId');
      if (appIdId) setSelectedAppIdId(appIdId);
      await loadAppleResources(developerTeamId);
      log('Apple bundle ID created', bundleId.trim());
    } catch (error) {
      onError(errorMessage(error, 'Failed to create bundle ID'));
    } finally {
      setBusy(undefined);
    }
  }

  async function registerDevice() {
    if (!canUseApple || !appleLogin.session || !developerTeamId || !deviceUDID) return;
    onError(undefined);
    setBusy('register-device');
    try {
      await registerAppleDevice({
        apiUrl: apiUrl!,
        token,
        appleSessionId: appleLogin.session.appleSessionId,
        teamId: developerTeamId,
        deviceUDID,
        name: deviceName ?? 'Limrun iPhone',
      });
      await loadAppleResources(developerTeamId);
      log('Registered connected iPhone', deviceUDID);
    } catch (error) {
      onError(errorMessage(error, 'Failed to register device'));
    } finally {
      setBusy(undefined);
    }
  }

  // --- Producing the signing assets ----------------------------------------

  async function prepareAppleSigning() {
    if (!canUseApple || !appleLogin.session || !developerTeamId) return;
    if (!bundleId.trim()) return onError('Enter a bundle ID.');
    if (!selectedAppIdId) return onError('Select or create a Bundle ID resource.');
    if (selectedDeviceIds.length === 0) return onError('Select at least one Apple Developer device.');

    onError(undefined);
    setBusy('signing');
    try {
      const base = {
        apiUrl: apiUrl!,
        token,
        appleSessionId: appleLogin.session.appleSessionId,
        teamId: developerTeamId,
      };
      let certificateId = storedCertificate?.certificateID;
      let certificateP12Base64 = storedCertificate?.certificateP12Base64;
      let p12Password = storedCertificate?.certificatePassword;

      // Reuse the stored private key, but resolve the canonical certificateId
      // the profile API expects (the stored value may be a certRequestId). If
      // the cert is no longer on the team (revoked), regenerate instead.
      let reuseStoredCertificate = false;
      if (certificateChoice === 'stored' && certificateId && certificateP12Base64) {
        const current = await listAppleCertificates({ ...base, certificateKind: 'development' });
        const matched = current.find(
          (item) =>
            stringField(item, 'certificateId') === certificateId ||
            stringField(item, 'certRequestId') === certificateId,
        );
        if (matched) {
          certificateId = stringField(matched, 'certificateId') ?? certificateId;
          reuseStoredCertificate = true;
          log('Reusing stored Apple certificate', certificateId);
        } else {
          log('Stored certificate is no longer on the team', 'Generating a new one.');
        }
      }

      if (!reuseStoredCertificate) {
        // The private key is generated and kept in this browser; Apple only ever
        // sees the CSR. Without this key the downloaded cert can't sign anything.
        const key = await generateAppleSigningKeyAndCSR({ commonName: `Limrun ${bundleId.trim()}` });
        const certificate = await createAppleCertificate({
          ...base,
          certificateKind: 'development',
          csrPEM: key.csrPEM,
        });
        certificateId =
          stringField(certificate, 'certificateId') ?? stringField(certificate, 'certRequestId');
        if (!certificateId) throw new Error('Apple certificate creation did not return a certificate ID.');
        const downloaded = await downloadAppleCertificate({
          ...base,
          certificateKind: 'development',
          certificateId,
        });
        if (!downloaded.rawBodyBase64) throw new Error('Apple certificate download returned no bytes.');
        certificateP12Base64 = exportAppleCertificateP12({
          privateKeyPKCS8Base64: key.privateKeyPKCS8Base64,
          certificateBase64: downloaded.rawBodyBase64,
          password: '',
          friendlyName: `Apple Development ${bundleId.trim()}`,
        });
        p12Password = undefined;
      }

      if (!certificateId || !certificateP12Base64) {
        throw new Error('Select a stored certificate or create a new certificate.');
      }

      // The profile ties the bundle ID, certificate, and device together. A
      // unique name avoids Apple's "multiple profiles with the same name" error.
      let profileId = selectedProfileId;
      if (profileChoice === 'create') {
        const profile = await createAppleProfile({
          ...base,
          profileKind: 'development',
          bundleId: bundleId.trim(),
          appIdId: selectedAppIdId,
          certificateIds: [certificateId],
          deviceIds: selectedDeviceIds,
          name: `Limrun ${bundleId.trim()} ${Date.now()}`,
        });
        profileId = stringField(profile, 'provisioningProfileId') ?? stringField(profile, 'profileId') ?? '';
      }
      if (!profileId) throw new Error('Select or create a provisioning profile.');
      const downloadedProfile = await downloadAppleProfile({ ...base, profileId });
      if (!downloadedProfile.rawBodyBase64) throw new Error('Profile download returned no bytes.');

      const assets = await putAppleGeneratedSigningAssets({
        bundleID: bundleId.trim(),
        deviceUDID,
        teamID: developerTeamId,
        signingMode: 'development',
        certificateID: certificateId,
        certificateP12Base64,
        certificatePassword: p12Password,
        provisioningProfileBase64: downloadedProfile.rawBodyBase64,
        profile: parseProvisioningProfileBase64(downloadedProfile.rawBodyBase64),
      });
      setSigningAssets(assets);
      await loadAppleResources(developerTeamId);
      log('Apple signing assets ready', assets.bundleID);
    } catch (error) {
      setSigningAssets(undefined);
      const message = errorMessage(error, 'Failed to prepare Apple signing assets');
      const capHit =
        /current Development certificate|pending certificate request|Maximum number of certificates/i.test(
          message,
        );
      onError(
        capHit ?
          `${message} — Apple caps development certificates at 2. Reuse a stored certificate, upload a .p12, or revoke one at developer.apple.com.`
        : message,
      );
    } finally {
      setBusy(undefined);
    }
  }

  async function prepareUploadSigning() {
    if (!certificateFile || !provisioningProfileFile) {
      onError('Select a .p12 certificate and a .mobileprovision profile first.');
      return;
    }
    onError(undefined);
    setBusy('signing');
    try {
      const assets = await importSigningAssetsFromFiles({
        certificateFile,
        provisioningProfileFile,
        certificatePassword: certificatePassword || undefined,
        bundleId: bundleId.trim() || undefined,
        deviceUDID,
        signingMode: 'development',
      });
      setSigningAssets(assets);
      log('Signing assets ready', assets.bundleID);
    } catch (error) {
      onError(errorMessage(error, 'Failed to prepare signing assets'));
    } finally {
      setBusy(undefined);
    }
  }

  /** Clear all signing state and close the Apple session (used on Stop sandbox). */
  function reset() {
    setSigningAssets(undefined);
    setResources(emptyAppleResources);
    void appleLogin.close();
  }

  return {
    // shared
    source,
    setSource,
    bundleId,
    setBundleId,
    signingAssets,
    busy,
    preparing: busy === 'signing',
    reset,
    // upload
    certificateFile,
    setCertificateFile,
    provisioningProfileFile,
    setProvisioningProfileFile,
    certificatePassword,
    setCertificatePassword,
    prepareUploadSigning,
    // apple
    appleLogin,
    appleAccount,
    setAppleAccount,
    applePassword,
    setApplePassword,
    twoFactorCode,
    setTwoFactorCode,
    resources,
    selectedTeamId,
    selectTeam,
    selectedAppIdId,
    setSelectedAppIdId,
    selectedDeviceIds,
    setSelectedDeviceIds,
    certificateChoice,
    setCertificateChoice,
    profileChoice,
    setProfileChoice,
    selectedProfileId,
    setSelectedProfileId,
    selectedProfile,
    storedCertificate,
    developerTeamId,
    canUseApple,
    canRegisterDevice,
    signInWithApple,
    submitTwoFactor,
    loadAppleResources,
    createBundleIdResource,
    registerDevice,
    prepareAppleSigning,
  };
}
