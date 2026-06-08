import { StrictMode, useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
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
  type AppleDeveloperPortalAppID,
  type AppleDeveloperPortalDevice,
  type AppleDeveloperPortalTeam,
} from '../../app-store-relay';
import { useAppleIDLogin } from '../../app-store-relay/react';
import {
  getLatestSigningAssetsWithCertificate,
  importSigningAssetsFromFiles,
  parseProvisioningProfileBase64,
  putAppleGeneratedSigningAssets,
  type StoredSigningAssets,
} from '../../device-build';
import { useDeviceBuild } from '../../device-build/react';
import { useDeviceInstallRelay } from '../react';
import './demo.css';

type ActivityLine = {
  id: number;
  time: string;
  message: string;
  detail?: string;
};

type SigningSource = 'apple' | 'upload';
type CertificateChoice = 'stored' | 'create';
type ProfileChoice = 'create' | 'existing';

type AppleResourceState = {
  teams: AppleDeveloperPortalTeam[];
  appIds: AppleDeveloperPortalAppID[];
  devices: AppleDeveloperPortalDevice[];
  certificates: Array<Record<string, unknown>>;
  profiles: Array<Record<string, unknown>>;
};

const emptyAppleResources: AppleResourceState = {
  teams: [],
  appIds: [],
  devices: [],
  certificates: [],
  profiles: [],
};

const storageKeys = {
  apiUrl: 'limrun-device-demo-api-url',
  token: 'limrun-device-demo-token',
  bundleId: 'limrun-device-demo-bundle-id',
  certificatePassword: 'limrun-device-demo-certificate-password',
  appleAccount: 'limrun-device-demo-apple-account',
};

function App() {
  const [apiUrl, setApiUrl] = useLocalStorage(storageKeys.apiUrl, 'http://127.0.0.1:8080');
  const [token, setToken] = useLocalStorage(storageKeys.token, '');
  const [bundleId, setBundleId] = useLocalStorage(storageKeys.bundleId, '');
  const [appleAccount, setAppleAccount] = useLocalStorage(storageKeys.appleAccount, '');
  const [certificatePassword, setCertificatePassword] = useLocalStorage(storageKeys.certificatePassword, '');
  const [signingSource, setSigningSource] = useState<SigningSource>('apple');
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
  const [appleBusy, setAppleBusy] = useState<string>();
  const [certificateFile, setCertificateFile] = useState<File>();
  const [profileFile, setProfileFile] = useState<File>();
  const [signingAssets, setSigningAssets] = useState<StoredSigningAssets>();
  const [activity, setActivity] = useState<ActivityLine[]>([]);
  const [prepareError, setPrepareError] = useState<string>();

  const addActivity = (message: string, detail?: string) => {
    setActivity((current) =>
      [
        {
          id: Date.now() + Math.random(),
          time: new Date().toLocaleTimeString(),
          message,
          detail,
        },
        ...current,
      ].slice(0, 120),
    );
  };

  const install = useDeviceInstallRelay({
    apiUrl: apiUrl.trim() || undefined,
    token: token.trim() || undefined,
    log: addActivity,
  });

  const build = useDeviceBuild({
    apiUrl: apiUrl.trim() || undefined,
    token: token.trim() || undefined,
    signingAssets,
  });

  const appleLogin = useAppleIDLogin({
    limbuildApiUrl: apiUrl.trim(),
    token: token.trim() || undefined,
  });

  const combinedError = prepareError ?? appleLogin.error ?? install.error ?? build.error;
  const selectedUDID = install.device?.hello.serialNumber;
  const selectedTeam = resources.teams.find((team) => appleTeamSelectionId(team) === selectedTeamId);
  const developerTeamId = selectedTeam?.teamId;
  const selectedProfile = resources.profiles.find(
    (profile) => stringField(profile, 'provisioningProfileId') === selectedProfileId,
  );
  const canUseApple = !!apiUrl.trim() && !!appleLogin.session?.appleSessionId && !!developerTeamId;
  const canPrepareSigning = !!certificateFile && !!profileFile;
  const canStartBuild = !!signingAssets && build.status !== 'queued' && build.status !== 'running';
  const canInstall = install.canInstall && build.status === 'succeeded';

  const buildLogText = useMemo(
    () =>
      build.logs
        .slice(-80)
        .map((line) => line.data)
        .join('\n'),
    [build.logs],
  );

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

  async function prepareSigningAssets() {
    if (!certificateFile || !profileFile) return;
    setPrepareError(undefined);
    try {
      const assets = await importSigningAssetsFromFiles({
        certificateFile,
        provisioningProfileFile: profileFile,
        certificatePassword,
        bundleId: bundleId.trim() || undefined,
        deviceUDID: selectedUDID,
        signingMode: 'development',
      });
      setSigningAssets(assets);
      if (!bundleId.trim()) {
        setBundleId(assets.bundleID);
      }
      addActivity('Signing assets ready', assets.bundleID);
    } catch (error) {
      setSigningAssets(undefined);
      setPrepareError(errorMessage(error));
    }
  }

  async function signInWithApple() {
    if (!apiUrl.trim()) return;
    setAppleBusy('login');
    setPrepareError(undefined);
    try {
      const session = await appleLogin.startLogin({
        accountName: appleAccount,
        password: applePassword,
      });
      setApplePassword('');
      if (session && !session.requiresTwoFactor) {
        await loadAppleTeams(session.appleSessionId);
      }
    } catch (error) {
      setPrepareError(errorMessage(error));
    } finally {
      setAppleBusy(undefined);
    }
  }

  async function submitAppleTwoFactor() {
    if (!appleLogin.session) return;
    setAppleBusy('2fa');
    setPrepareError(undefined);
    try {
      await appleLogin.submitTwoFactorCode(twoFactorCode);
      setTwoFactorCode('');
      await loadAppleTeams(appleLogin.session.appleSessionId);
    } catch (error) {
      setPrepareError(errorMessage(error));
    } finally {
      setAppleBusy(undefined);
    }
  }

  async function loadAppleTeams(appleSessionId = appleLogin.session?.appleSessionId) {
    if (!apiUrl.trim() || !appleSessionId) return;
    setAppleBusy('teams');
    setPrepareError(undefined);
    try {
      await appleLogin.finalize().catch(() => undefined);
      const teams = await listAppleTeams({
        apiUrl: apiUrl.trim(),
        token: token.trim() || undefined,
        appleSessionId,
      });
      setResources((current) => ({ ...current, teams }));
      const firstTeamId = teams.map(appleTeamSelectionId).find(Boolean) ?? '';
      setSelectedTeamId(firstTeamId);
      const firstDeveloperTeamId = teams.find((team) => appleTeamSelectionId(team) === firstTeamId)?.teamId;
      if (firstDeveloperTeamId) {
        await loadAppleResources(firstDeveloperTeamId, appleSessionId);
      }
    } catch (error) {
      setPrepareError(errorMessage(error));
    } finally {
      setAppleBusy(undefined);
    }
  }

  async function loadAppleResources(
    teamId = developerTeamId,
    appleSessionId = appleLogin.session?.appleSessionId,
  ) {
    if (!apiUrl.trim() || !appleSessionId || !teamId) return;
    const base = {
      apiUrl: apiUrl.trim(),
      token: token.trim() || undefined,
      appleSessionId,
      teamId,
    };
    const [appIds, devices, certificates, profiles] = await Promise.all([
      listAppleBundleIDs(base),
      listAppleDevices(base),
      listAppleCertificates({ ...base, certificateKind: 'development' }),
      listAppleProfiles({ ...base, profileKind: 'development' }),
    ]);
    setResources((current) => ({ ...current, appIds, devices, certificates, profiles }));
    const firstApp = appIds[0];
    const firstAppId = appIdIdentifier(firstApp) ?? '';
    const firstBundleId = appIdBundleId(firstApp);
    setSelectedAppIdId(firstAppId);
    if (!bundleId.trim() && firstBundleId) setBundleId(firstBundleId);
    const matchingDevice =
      selectedUDID ? devices.find((device) => sameUDID(device.deviceNumber, selectedUDID)) : undefined;
    const firstDeviceId = matchingDevice?.deviceId ?? devices.find((device) => !!device.deviceId)?.deviceId;
    setSelectedDeviceIds(firstDeviceId ? [firstDeviceId] : []);
    setSelectedProfileId(
      profiles.map((profile) => stringField(profile, 'provisioningProfileId')).find(Boolean) ?? '',
    );
    addActivity('Apple Developer resources loaded', `${devices.length} devices, ${profiles.length} profiles`);
  }

  async function createBundleIdResource() {
    if (!canUseApple || !bundleId.trim() || !appleLogin.session || !developerTeamId) return;
    setAppleBusy('bundle');
    setPrepareError(undefined);
    try {
      const app = await createAppleBundleID({
        apiUrl: apiUrl.trim(),
        token: token.trim() || undefined,
        appleSessionId: appleLogin.session.appleSessionId,
        teamId: developerTeamId,
        bundleId: bundleId.trim(),
      });
      const appIdId = stringField(app, 'appIdId') ?? stringField(app, 'appId');
      if (appIdId) setSelectedAppIdId(appIdId);
      await loadAppleResources(developerTeamId);
      addActivity('Apple bundle ID created', bundleId.trim());
    } catch (error) {
      setPrepareError(errorMessage(error));
    } finally {
      setAppleBusy(undefined);
    }
  }

  async function registerSelectedIPhone() {
    if (!canUseApple || !appleLogin.session || !developerTeamId || !selectedUDID) return;
    setAppleBusy('register-device');
    setPrepareError(undefined);
    try {
      await registerAppleDevice({
        apiUrl: apiUrl.trim(),
        token: token.trim() || undefined,
        appleSessionId: appleLogin.session.appleSessionId,
        teamId: developerTeamId,
        deviceUDID: selectedUDID,
        name: install.device?.hello.productName ?? 'Limrun iPhone',
      });
      await loadAppleResources(developerTeamId);
      addActivity('Registered connected iPhone', selectedUDID);
    } catch (error) {
      setPrepareError(errorMessage(error));
    } finally {
      setAppleBusy(undefined);
    }
  }

  async function prepareAppleSigningAssets() {
    if (!canUseApple || !appleLogin.session || !developerTeamId) return;
    if (!bundleId.trim()) {
      setPrepareError('Enter a bundle ID.');
      return;
    }
    if (!selectedAppIdId) {
      setPrepareError('Select or create a Bundle ID resource.');
      return;
    }
    if (selectedDeviceIds.length === 0) {
      setPrepareError('Select at least one Apple Developer device.');
      return;
    }
    setAppleBusy('signing');
    setPrepareError(undefined);
    try {
      const base = {
        apiUrl: apiUrl.trim(),
        token: token.trim() || undefined,
        appleSessionId: appleLogin.session.appleSessionId,
        teamId: developerTeamId,
      };
      let certificateId = storedCertificate?.certificateID;
      let certificateP12Base64 = storedCertificate?.certificateP12Base64;
      let storedCertificatePassword = storedCertificate?.certificatePassword;

      // Reuse whenever we hold the certificate's private key locally (.p12).
      // Possessing the key is what matters for signing; we do NOT regenerate on
      // a portal ID-match miss, because Apple's certRequestId/certificateId
      // fields are inconsistent and a false miss would mint a new cert and hit
      // the 2-cert development cap. The portal check is informational only.
      const reuseStoredCertificate =
        certificateChoice === 'stored' && !!certificateId && !!certificateP12Base64;
      if (reuseStoredCertificate) {
        const currentCertificates = await listAppleCertificates({
          ...base,
          certificateKind: 'development',
        }).catch(() => [] as Array<Record<string, unknown>>);
        const stillCurrent = currentCertificates.some(
          (item) =>
            stringField(item, 'certificateId') === certificateId ||
            stringField(item, 'certRequestId') === certificateId,
        );
        addActivity(
          'Reusing stored Apple certificate',
          stillCurrent ? certificateId : `${certificateId} (not matched on portal; reusing local key anyway)`,
        );
      }

      if (!reuseStoredCertificate) {
        const keyMaterial = await generateAppleSigningKeyAndCSR({
          commonName: `Limrun ${bundleId.trim()}`,
        });
        const certificate = await createAppleCertificate({
          ...base,
          certificateKind: 'development',
          csrPEM: keyMaterial.csrPEM,
        });
        certificateId =
          stringField(certificate, 'certificateId') ?? stringField(certificate, 'certRequestId');
        if (!certificateId) throw new Error('Apple certificate creation did not return a certificate ID.');
        const downloadedCertificate = await downloadAppleCertificate({
          ...base,
          certificateKind: 'development',
          certificateId,
        });
        if (!downloadedCertificate.rawBodyBase64) {
          throw new Error('Apple certificate download did not return certificate bytes.');
        }
        certificateP12Base64 = exportAppleCertificateP12({
          privateKeyPKCS8Base64: keyMaterial.privateKeyPKCS8Base64,
          certificateBase64: downloadedCertificate.rawBodyBase64,
          password: certificatePassword,
          friendlyName: `Apple Development ${bundleId.trim()}`,
        });
        storedCertificatePassword = certificatePassword || undefined;
      }

      if (!certificateId || !certificateP12Base64) {
        throw new Error('Select a stored certificate or create a new certificate.');
      }

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
      if (!downloadedProfile.rawBodyBase64) {
        throw new Error('Apple provisioning profile download did not return profile bytes.');
      }
      const profile = parseProvisioningProfileBase64(downloadedProfile.rawBodyBase64);
      const assets = await putAppleGeneratedSigningAssets({
        bundleID: bundleId.trim(),
        deviceUDID: selectedUDID,
        teamID: developerTeamId,
        signingMode: 'development',
        certificateID: certificateId,
        certificateP12Base64,
        certificatePassword: storedCertificatePassword,
        provisioningProfileBase64: downloadedProfile.rawBodyBase64,
        profile,
      });
      setSigningAssets(assets);
      await loadAppleResources(developerTeamId);
      addActivity('Apple signing assets ready', assets.bundleID);
    } catch (error) {
      setSigningAssets(undefined);
      const message = errorMessage(error);
      const capHit =
        /current Development certificate|pending certificate request|Maximum number of certificates/i.test(
          message,
        );
      setPrepareError(
        capHit ?
          `${message}\n\nApple caps development certificates at 2. Either pick "Use stored local certificate" (if this browser already created one), upload a .p12 instead, or revoke an existing certificate at developer.apple.com and retry.`
        : message,
      );
    } finally {
      setAppleBusy(undefined);
    }
  }

  async function startBuild() {
    const execId = await build.startBuild({ signingAssets });
    if (execId) {
      addActivity('Signed device build started', execId);
    }
  }

  return (
    <main className="page">
      <header className="hero">
        <p className="eyebrow">Limrun WebUSB Demo</p>
        <h1>Install a signed iOS build onto a physical iPhone</h1>
        <p>
          This page demonstrates the upload-signing path from
          <code> REAL_DEVICE_INSTALL_README.md</code>: select an iPhone, pair it, upload signing assets, start
          a signed <code>iphoneos</code> build, and install over WebUSB.
        </p>
      </header>

      {combinedError && (
        <section className="error">
          <strong>Install flow failed</strong>
          <pre>{combinedError}</pre>
        </section>
      )}

      <section className="card">
        <h2>Connection</h2>
        <div className="grid two">
          <label>
            limbuild API URL
            <input
              value={apiUrl}
              onChange={(event) => setApiUrl(event.currentTarget.value)}
              placeholder="http://127.0.0.1:8080"
            />
          </label>
          <label>
            Token (optional)
            <input
              value={token}
              onChange={(event) => setToken(event.currentTarget.value)}
              placeholder="Instance token, if required"
            />
          </label>
        </div>
        <p className="hint">
          Run this page on <code>localhost</code> or HTTPS. WebUSB is available in Chromium browsers only.
        </p>
      </section>

      <section className="card">
        <div className="sectionHeader">
          <div>
            <h2>1. Pair iPhone</h2>
            <p>Select the USB device, then pair. Unlock the iPhone and tap Trust.</p>
          </div>
          <StatusPill tone={install.hasPairRecord ? 'success' : 'neutral'}>
            {install.hasPairRecord ? 'Pair record stored' : 'No pair record yet'}
          </StatusPill>
        </div>
        <div className="actions">
          <button
            type="button"
            disabled={!apiUrl.trim() || !!install.busyAction}
            onClick={() => void install.requestUSBAccess()}
          >
            Select iPhone
          </button>
          <button type="button" disabled={!install.canPair} onClick={() => void install.pairBrowser()}>
            Pair
          </button>
          <button type="button" className="secondary" onClick={install.stopRelay}>
            Stop relay
          </button>
        </div>
        <dl className="facts">
          <div>
            <dt>Device</dt>
            <dd>{install.device?.hello.productName ?? 'Not selected'}</dd>
          </div>
          <div>
            <dt>UDID</dt>
            <dd>{selectedUDID ?? 'Not selected'}</dd>
          </div>
          <div>
            <dt>Busy action</dt>
            <dd>{install.busyAction ?? 'idle'}</dd>
          </div>
        </dl>
      </section>

      <section className="card">
        <div className="sectionHeader">
          <div>
            <h2>2. Prepare signing assets</h2>
            <p>
              Use the Apple Developer relay or upload a <code>.p12</code> and
              <code> .mobileprovision</code> directly.
            </p>
          </div>
          <StatusPill tone={signingAssets ? 'success' : 'neutral'}>
            {signingAssets ? 'Signing assets ready' : 'Signing assets missing'}
          </StatusPill>
        </div>

        <div className="tabs" role="tablist" aria-label="Signing source">
          <button
            type="button"
            className={signingSource === 'apple' ? 'tab active' : 'tab'}
            onClick={() => setSigningSource('apple')}
          >
            Apple Developer
          </button>
          <button
            type="button"
            className={signingSource === 'upload' ? 'tab active' : 'tab'}
            onClick={() => setSigningSource('upload')}
          >
            Upload files
          </button>
        </div>

        <div className="grid two">
          <label>
            Bundle ID
            <input
              value={bundleId}
              onChange={(event) => setBundleId(event.currentTarget.value)}
              placeholder="com.example.MyApp"
            />
          </label>
          <label>
            Certificate password
            <input
              type="password"
              value={certificatePassword}
              onChange={(event) => setCertificatePassword(event.currentTarget.value)}
            />
          </label>
          <label>
            .p12 certificate
            <input
              type="file"
              accept=".p12,application/x-pkcs12"
              onChange={(event) => updateFile(setCertificateFile, event)}
            />
          </label>
          <label>
            .mobileprovision profile
            <input
              type="file"
              accept=".mobileprovision"
              onChange={(event) => updateFile(setProfileFile, event)}
            />
          </label>
        </div>

        {signingSource === 'apple' ?
          <div className="subPanel">
            <div className="sectionHeader compact">
              <div>
                <h3>Apple ID</h3>
                <p>Status: {appleLogin.status}</p>
              </div>
              <button
                type="button"
                disabled={!appleAccount || !applePassword || appleBusy === 'login'}
                onClick={() => void signInWithApple()}
              >
                Sign in
              </button>
            </div>
            <div className="grid two">
              <label>
                Apple ID
                <input
                  type="email"
                  autoComplete="username"
                  value={appleAccount}
                  onChange={(event) => setAppleAccount(event.currentTarget.value)}
                />
              </label>
              <label>
                Apple ID password
                <input
                  type="password"
                  autoComplete="current-password"
                  value={applePassword}
                  onChange={(event) => setApplePassword(event.currentTarget.value)}
                />
              </label>
            </div>
            {appleLogin.status === 'two-factor-required' && (
              <div className="inlineForm">
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="Two-factor code"
                  value={twoFactorCode}
                  onChange={(event) => setTwoFactorCode(event.currentTarget.value)}
                />
                <button
                  type="button"
                  disabled={!twoFactorCode || appleBusy === '2fa'}
                  onClick={() => void submitAppleTwoFactor()}
                >
                  Submit code
                </button>
              </div>
            )}

            <div className="grid two">
              <label>
                Team
                <select
                  value={selectedTeamId}
                  disabled={resources.teams.length === 0}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setSelectedTeamId(value);
                    const team = resources.teams.find((item) => appleTeamSelectionId(item) === value);
                    if (team?.teamId) void loadAppleResources(team.teamId);
                  }}
                >
                  <option value="">Sign in to load teams</option>
                  {resources.teams.map((team, index) => {
                    const value = appleTeamSelectionId(team) ?? `team-${index}`;
                    return (
                      <option key={value} value={value}>
                        {team.name ?? value}
                      </option>
                    );
                  })}
                </select>
              </label>
              <label>
                Bundle ID resource
                <select
                  value={selectedAppIdId}
                  disabled={resources.appIds.length === 0}
                  onChange={(event) => setSelectedAppIdId(event.currentTarget.value)}
                >
                  <option value="">Select or create a Bundle ID resource</option>
                  {resources.appIds.map((appId, index) => {
                    const value = appIdIdentifier(appId) ?? `app-${index}`;
                    return (
                      <option key={value} value={value}>
                        {appIdBundleId(appId) ?? appId.name ?? value}
                      </option>
                    );
                  })}
                </select>
              </label>
            </div>
            <div className="actions">
              <button
                type="button"
                disabled={!canUseApple || !bundleId.trim() || appleBusy === 'bundle'}
                onClick={() => void createBundleIdResource()}
              >
                Create bundle ID
              </button>
              <button
                type="button"
                className="secondary"
                disabled={!canUseApple || !selectedUDID || appleBusy === 'register-device'}
                onClick={() => void registerSelectedIPhone()}
              >
                Register selected iPhone
              </button>
              <button
                type="button"
                className="secondary"
                disabled={!appleLogin.session || appleBusy === 'teams'}
                onClick={() => void loadAppleTeams()}
              >
                Reload Apple resources
              </button>
            </div>
            <div className="grid two">
              <label>
                Apple devices
                <select
                  multiple
                  className="multiSelect"
                  value={selectedDeviceIds}
                  onChange={(event) =>
                    setSelectedDeviceIds(
                      Array.from(event.currentTarget.selectedOptions).map((option) => option.value),
                    )
                  }
                >
                  {resources.devices.map((device, index) => {
                    const value = device.deviceId ?? `device-${index}`;
                    return (
                      <option key={value} value={value}>
                        {device.name ?? device.deviceNumber ?? value}
                      </option>
                    );
                  })}
                </select>
              </label>
              <label>
                Existing profile
                <select
                  value={selectedProfileId}
                  disabled={resources.profiles.length === 0}
                  onChange={(event) => setSelectedProfileId(event.currentTarget.value)}
                >
                  <option value="">Select profile</option>
                  {resources.profiles.map((profile, index) => {
                    const value = stringField(profile, 'provisioningProfileId') ?? `profile-${index}`;
                    return (
                      <option key={value} value={value}>
                        {stringField(profile, 'name') ?? value}
                      </option>
                    );
                  })}
                </select>
              </label>
              <label>
                Certificate
                <select
                  value={certificateChoice}
                  onChange={(event) => setCertificateChoice(event.currentTarget.value as CertificateChoice)}
                >
                  <option value="stored" disabled={!storedCertificate}>
                    Use stored local certificate
                  </option>
                  <option value="create">Create new certificate</option>
                </select>
              </label>
              <label>
                Provisioning profile
                <select
                  value={profileChoice}
                  onChange={(event) => setProfileChoice(event.currentTarget.value as ProfileChoice)}
                >
                  <option value="create">Create new profile</option>
                  <option value="existing" disabled={!selectedProfile}>
                    Use selected existing profile
                  </option>
                </select>
              </label>
            </div>
            <p className="hint">
              Apple account has {resources.certificates.length} matching development certificates. Existing
              Apple certs can only be reused when this browser already has the private key.
            </p>
            <div className="actions">
              <button
                type="button"
                disabled={!canUseApple || appleBusy === 'signing'}
                onClick={() => void prepareAppleSigningAssets()}
              >
                Prepare Apple signing assets
              </button>
            </div>
          </div>
        : <div className="subPanel">
            <p className="hint">
              Use a development <code>.mobileprovision</code> that includes the selected iPhone UDID and
              covers the app bundle ID.
            </p>
            <div className="grid two">
              <label>
                .p12 certificate
                <input
                  type="file"
                  accept=".p12,application/x-pkcs12"
                  onChange={(event) => updateFile(setCertificateFile, event)}
                />
              </label>
              <label>
                .mobileprovision profile
                <input
                  type="file"
                  accept=".mobileprovision"
                  onChange={(event) => updateFile(setProfileFile, event)}
                />
              </label>
            </div>
            <div className="actions">
              <button type="button" disabled={!canPrepareSigning} onClick={() => void prepareSigningAssets()}>
                Prepare uploaded signing assets
              </button>
            </div>
          </div>
        }

        {signingAssets && (
          <dl className="facts">
            <div>
              <dt>Profile bundle</dt>
              <dd>{signingAssets.profile.bundleID ?? signingAssets.bundleID}</dd>
            </div>
            <div>
              <dt>Team</dt>
              <dd>{signingAssets.teamID ?? signingAssets.profile.teamID ?? 'unknown'}</dd>
            </div>
            <div>
              <dt>Devices in profile</dt>
              <dd>{signingAssets.profile.provisionedDevices.length}</dd>
            </div>
          </dl>
        )}
      </section>

      <section className="card">
        <div className="sectionHeader">
          <div>
            <h2>3. Build</h2>
            <p>Starts a signed device build on limbuild and streams xcodebuild logs.</p>
          </div>
          <StatusPill
            tone={
              build.status === 'succeeded' ? 'success'
              : build.status === 'failed' ?
                'danger'
              : 'neutral'
            }
          >
            {build.status}
          </StatusPill>
        </div>
        <div className="actions">
          <button type="button" disabled={!canStartBuild} onClick={() => void startBuild()}>
            Start signed build
          </button>
        </div>
        <pre className="logBox">{buildLogText || 'Build logs will appear here.'}</pre>
      </section>

      <section className="card">
        <div className="sectionHeader">
          <div>
            <h2>4. Install</h2>
            <p>Installs the latest successful signed build onto the paired iPhone.</p>
          </div>
          <StatusPill tone={canInstall ? 'success' : 'neutral'}>
            {canInstall ? 'Ready to install' : 'Waiting'}
          </StatusPill>
        </div>
        <div className="actions">
          <button type="button" disabled={!canInstall} onClick={() => void install.startInstallation()}>
            Install to iPhone
          </button>
        </div>
      </section>

      <section className="card">
        <div className="sectionHeader">
          <div>
            <h2>Activity</h2>
            <p>Device, relay, signing, build, and install events.</p>
          </div>
          <button type="button" className="secondary" onClick={() => setActivity([])}>
            Clear
          </button>
        </div>
        <div className="activity">
          {activity.length === 0 ?
            <p className="hint">No activity yet.</p>
          : activity.map((line) => (
              <div key={line.id} className="activityLine">
                <span>{line.time}</span>
                <strong>{line.message}</strong>
                {line.detail && <pre>{line.detail}</pre>}
              </div>
            ))
          }
        </div>
      </section>
    </main>
  );
}

function StatusPill({ tone, children }: { tone: 'neutral' | 'success' | 'danger'; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

function updateFile(setter: (file: File | undefined) => void, event: ChangeEvent<HTMLInputElement>) {
  setter(event.currentTarget.files?.[0]);
}

function appleTeamSelectionId(team?: AppleDeveloperPortalTeam) {
  const value = team?.teamId ?? team?.providerId ?? team?.publicProviderId;
  return value === undefined || value === '' ? undefined : String(value);
}

function appIdIdentifier(appId?: AppleDeveloperPortalAppID) {
  return appId?.appIdId ?? appId?.appId ?? appId?.identifier ?? appId?.bundleId;
}

function appIdBundleId(appId?: AppleDeveloperPortalAppID) {
  return appId?.identifier ?? appId?.bundleId;
}

function stringField(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function sameUDID(left?: string, right?: string) {
  return normalizeUDID(left) === normalizeUDID(right);
}

function normalizeUDID(udid?: string) {
  return (udid ?? '')
    .replace(/-/g, '')
    .replace(/[^a-fA-F0-9]/g, '')
    .toUpperCase();
}

function useLocalStorage(key: string, initialValue: string) {
  const [value, setValue] = useState(() => localStorage.getItem(key) ?? initialValue);
  useEffect(() => {
    localStorage.setItem(key, value);
  }, [key, value]);
  return [value, setValue] as const;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
