import { useCallback, useEffect, useMemo, useState } from 'react';
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
} from '@limrun/ui/app-store-relay';
import { useAppleIDLogin } from '@limrun/ui/app-store-relay/react';
import {
  getLatestSigningAssetsWithCertificate,
  importSigningAssetsFromFiles,
  parseProvisioningProfileBase64,
  putAppleGeneratedSigningAssets,
  type StoredSigningAssets,
} from '@limrun/ui/device-build';
import { useDeviceBuild } from '@limrun/ui/device-build/react';
import { useDeviceInstallRelay } from '@limrun/ui/device-install/react';

type Sandbox = { id: string; apiUrl: string; token: string };

type LogEntry = { at: string; message: string; detail?: string };

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

function App() {
  const [sandbox, setSandbox] = useState<Sandbox | undefined>();
  const [provisioning, setProvisioning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [log, setLog] = useState<LogEntry[]>([]);

  // Shared signing inputs.
  const [signingSource, setSigningSource] = useState<SigningSource>('apple');
  const [bundleId, setBundleId] = useState('');
  const [certificatePassword, setCertificatePassword] = useState('');
  const [signingAssets, setSigningAssets] = useState<StoredSigningAssets>();
  const [signing, setSigning] = useState(false);

  // Upload-path inputs.
  const [certificateFile, setCertificateFile] = useState<File>();
  const [provisioningProfileFile, setProvisioningProfileFile] = useState<File>();

  // Apple ID path inputs.
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
  const [appleBusy, setAppleBusy] = useState<string>();

  const pushLog = useCallback((message: string, detail?: unknown) => {
    setLog((current) => [
      { at: new Date().toLocaleTimeString(), message, detail: detail ? String(detail) : undefined },
      ...current,
    ]);
  }, []);

  const apiUrl = sandbox?.apiUrl;
  const token = sandbox?.token;

  const install = useDeviceInstallRelay({ apiUrl, token, log: pushLog });
  const build = useDeviceBuild({ apiUrl, token, signingAssets });
  const appleLogin = useAppleIDLogin({ limbuildApiUrl: apiUrl ?? '', token });

  const deviceUDID = install.device?.hello.serialNumber;

  // Resolve the team id the same way the <select> value is computed, so teams
  // whose portal id lives in providerId/publicProviderId (not teamId) still
  // drive the Apple Developer flow.
  const selectedTeam = resources.teams.find((team) => appleTeamSelectionId(team) === selectedTeamId);
  const developerTeamId = appleTeamSelectionId(selectedTeam);
  const selectedProfile = resources.profiles.find(
    (profile) => stringField(profile, 'provisioningProfileId') === selectedProfileId,
  );
  const canUseApple = !!apiUrl && !!appleLogin.session?.appleSessionId && !!developerTeamId;

  const createSandbox = async () => {
    try {
      setError(undefined);
      setProvisioning(true);
      const response = await fetch('http://localhost:3000/create-sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webSessionId: `web-${Date.now()}` }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.message || 'Failed to create sandbox');
        return;
      }
      setSandbox({ id: data.id, apiUrl: data.apiUrl, token: data.token });
      pushLog('Xcode sandbox ready', data.apiUrl);
      pushLog('Next: sync your project into the sandbox', `lim xcode sync . --id ${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unknown error occurred');
    } finally {
      setProvisioning(false);
    }
  };

  const stopSandbox = async () => {
    if (!sandbox) return;
    try {
      setError(undefined);
      setStopping(true);
      install.stopRelay();
      const response = await fetch('http://localhost:3000/stop-sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sandboxId: sandbox.id }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.message || 'Failed to stop sandbox');
        return;
      }
      setSandbox(undefined);
      setSigningAssets(undefined);
      setResources(emptyAppleResources);
      void appleLogin.close();
      build.reset();
      pushLog('Sandbox stopped');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unknown error occurred');
    } finally {
      setStopping(false);
    }
  };

  const pickDevice = async () => {
    setError(undefined);
    await install.requestUSBAccess();
  };

  const pairDevice = async () => {
    setError(undefined);
    await install.pairBrowser();
  };

  const prepareSigning = async () => {
    if (!certificateFile || !provisioningProfileFile) {
      setError('Select a .p12 certificate and a .mobileprovision profile first.');
      return;
    }
    try {
      setError(undefined);
      setSigning(true);
      const assets = await importSigningAssetsFromFiles({
        certificateFile,
        provisioningProfileFile,
        certificatePassword: certificatePassword || undefined,
        bundleId: bundleId.trim() || undefined,
        deviceUDID,
        signingMode: 'development',
      });
      setSigningAssets(assets);
      pushLog('Signing assets ready', assets.bundleID);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to prepare signing assets');
    } finally {
      setSigning(false);
    }
  };

  // When a team is selected, surface any certificate this browser already
  // created for it (Apple never returns private keys, so only locally stored
  // certs can be reused).
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

  const signInWithApple = async () => {
    if (!apiUrl) {
      setError('Create a sandbox first.');
      return;
    }
    setError(undefined);
    setAppleBusy('login');
    try {
      const session = await appleLogin.startLogin({ accountName: appleAccount, password: applePassword });
      if (session && !session.requiresTwoFactor) {
        // Clear the password only once login has fully completed; keep it while
        // a two-factor code is still required so the user doesn't have to retype.
        setApplePassword('');
        await loadAppleTeams(session.appleSessionId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Apple sign-in failed');
    } finally {
      setAppleBusy(undefined);
    }
  };

  const submitAppleTwoFactor = async () => {
    if (!appleLogin.session) return;
    setError(undefined);
    setAppleBusy('2fa');
    try {
      await appleLogin.submitTwoFactorCode(twoFactorCode);
      setTwoFactorCode('');
      setApplePassword('');
      await loadAppleTeams(appleLogin.session.appleSessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Two-factor verification failed');
    } finally {
      setAppleBusy(undefined);
    }
  };

  const loadAppleTeams = async (appleSessionId = appleLogin.session?.appleSessionId) => {
    if (!apiUrl || !appleSessionId) return;
    setAppleBusy('teams');
    try {
      await appleLogin.finalize().catch(() => undefined);
      const teams = await listAppleTeams({ apiUrl, token, appleSessionId });
      setResources((current) => ({ ...current, teams }));
      const firstTeamId = teams.map(appleTeamSelectionId).find(Boolean) ?? '';
      setSelectedTeamId(firstTeamId);
      if (firstTeamId) await loadAppleResources(firstTeamId, appleSessionId);
      pushLog('Apple teams loaded', String(teams.length));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Apple teams');
    } finally {
      setAppleBusy(undefined);
    }
  };

  const loadAppleResources = async (
    teamId = developerTeamId,
    appleSessionId = appleLogin.session?.appleSessionId,
  ) => {
    if (!apiUrl || !appleSessionId || !teamId) return;
    const base = { apiUrl, token, appleSessionId, teamId };
    const [appIds, devices, certificates, profiles] = await Promise.all([
      listAppleBundleIDs(base),
      listAppleDevices(base),
      listAppleCertificates({ ...base, certificateKind: 'development' }),
      listAppleProfiles({ ...base, profileKind: 'development' }),
    ]);
    setResources((current) => ({ ...current, appIds, devices, certificates, profiles }));
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
  };

  const createBundleIdResource = async () => {
    if (!canUseApple || !bundleId.trim() || !appleLogin.session || !developerTeamId) return;
    setError(undefined);
    setAppleBusy('bundle');
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
      pushLog('Apple bundle ID created', bundleId.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create bundle ID');
    } finally {
      setAppleBusy(undefined);
    }
  };

  const registerSelectedIPhone = async () => {
    if (!canUseApple || !appleLogin.session || !developerTeamId || !deviceUDID) return;
    setError(undefined);
    setAppleBusy('register-device');
    try {
      await registerAppleDevice({
        apiUrl: apiUrl!,
        token,
        appleSessionId: appleLogin.session.appleSessionId,
        teamId: developerTeamId,
        deviceUDID,
        name: install.device?.hello.productName ?? 'Limrun iPhone',
      });
      await loadAppleResources(developerTeamId);
      pushLog('Registered connected iPhone', deviceUDID);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to register device');
    } finally {
      setAppleBusy(undefined);
    }
  };

  const prepareAppleSigning = async () => {
    if (!canUseApple || !appleLogin.session || !developerTeamId) return;
    if (!bundleId.trim()) {
      setError('Enter a bundle ID.');
      return;
    }
    if (!selectedAppIdId) {
      setError('Select or create a Bundle ID resource.');
      return;
    }
    if (selectedDeviceIds.length === 0) {
      setError('Select at least one Apple Developer device.');
      return;
    }
    setError(undefined);
    setSigning(true);
    setAppleBusy('signing');
    try {
      const base = {
        apiUrl: apiUrl!,
        token,
        appleSessionId: appleLogin.session.appleSessionId,
        teamId: developerTeamId,
      };
      let certificateId = storedCertificate?.certificateID;
      let certificateP12Base64 = storedCertificate?.certificateP12Base64;
      let storedCertificatePassword = storedCertificate?.certificatePassword;

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
          pushLog('Reusing stored Apple certificate', certificateId);
        } else {
          pushLog('Stored certificate is no longer on the team', 'Generating a new one.');
        }
      }

      if (!reuseStoredCertificate) {
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
        profileId =
          stringField(profile, 'provisioningProfileId') ?? stringField(profile, 'profileId') ?? '';
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
        certificatePassword: storedCertificatePassword,
        provisioningProfileBase64: downloadedProfile.rawBodyBase64,
        profile: parseProvisioningProfileBase64(downloadedProfile.rawBodyBase64),
      });
      setSigningAssets(assets);
      await loadAppleResources(developerTeamId);
      pushLog('Apple signing assets ready', assets.bundleID);
    } catch (err) {
      setSigningAssets(undefined);
      const message = err instanceof Error ? err.message : 'Failed to prepare Apple signing assets';
      const capHit =
        /current Development certificate|pending certificate request|Maximum number of certificates/i.test(
          message,
        );
      setError(
        capHit ?
          `${message} — Apple caps development certificates at 2. Reuse a stored certificate, upload a .p12, or revoke one at developer.apple.com.`
        : message,
      );
    } finally {
      setSigning(false);
      setAppleBusy(undefined);
    }
  };

  const startBuild = async () => {
    setError(undefined);
    pushLog('Build started');
    await build.startBuild();
  };

  const startInstall = async () => {
    setError(undefined);
    await install.startInstallation();
  };

  const steps = useMemo(
    () => [
      { label: 'Pair iPhone', done: install.hasPairRecord, active: !!install.device },
      { label: 'Sign', done: !!signingAssets, active: install.hasPairRecord },
      { label: 'Build', done: build.status === 'succeeded', active: !!signingAssets },
      { label: 'Install', done: false, active: install.canInstall && build.status === 'succeeded' },
    ],
    [install.device, install.hasPairRecord, install.canInstall, signingAssets, build.status],
  );

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {/* Left sidebar */}
      <div
        style={{
          width: '360px',
          padding: '24px',
          backgroundColor: '#f8f9fa',
          borderRight: '1px solid #e0e0e0',
          display: 'flex',
          flexDirection: 'column',
          gap: '18px',
          boxSizing: 'border-box',
          overflowY: 'auto',
        }}
      >
        <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 600 }}>Limrun Device Install</h1>

        {/* Step 0: sandbox */}
        <Section title="1. Build sandbox">
          {!sandbox ?
            <button style={primaryButton(provisioning)} onClick={createSandbox} disabled={provisioning}>
              {provisioning ? 'Provisioning...' : 'Create Xcode sandbox'}
            </button>
          : <>
              <div style={infoBox}>
                Sandbox <code>{sandbox.id}</code> ready.
              </div>
              <div style={warnBox}>
                Now sync your project into <strong>this</strong> sandbox before building, otherwise the build
                returns <code>no synced folder found</code>. Pass <code>--id</code> so it targets the right
                instance:
                <pre style={codeBlock}>lim xcode sync . --id {sandbox.id}</pre>
                Run it from your project root (or build directly with{' '}
                <code>lim xcode build . --id {sandbox.id}</code>).
              </div>
              <button style={dangerButton(stopping)} onClick={stopSandbox} disabled={stopping}>
                {stopping ? 'Stopping...' : 'Stop sandbox'}
              </button>
            </>
          }
        </Section>

        {sandbox && (
          <>
            {/* Step 1: pair */}
            <Section title="2. Pair iPhone">
              <button style={secondaryButton(install.busyAction === 'usb')} onClick={pickDevice}>
                {install.device ? `Selected: ${install.device.hello.productName}` : 'Select iPhone (WebUSB)'}
              </button>
              <button
                style={secondaryButton(!install.canPair)}
                onClick={pairDevice}
                disabled={!install.canPair}
              >
                {install.busyAction === 'pair' ? 'Pairing...' : 'Pair (tap Trust on device)'}
              </button>
              {install.hasPairRecord && <div style={infoBox}>Paired. Pair record stored in this browser.</div>}
              {install.pairConfirmationRequired && (
                <div style={warnBox}>Unlock the iPhone, tap Trust, then pair again.</div>
              )}
            </Section>

            {/* Step 2: signing */}
            <Section title="3. Signing assets">
              <div style={tabRow}>
                <button
                  style={tabButton(signingSource === 'apple')}
                  onClick={() => setSigningSource('apple')}
                >
                  Apple ID
                </button>
                <button
                  style={tabButton(signingSource === 'upload')}
                  onClick={() => setSigningSource('upload')}
                >
                  Upload files
                </button>
              </div>

              <label style={labelStyle}>Bundle ID</label>
              <input
                style={inputStyle}
                placeholder="com.example.MyApp"
                value={bundleId}
                onChange={(e) => setBundleId(e.target.value)}
              />
              <label style={labelStyle}>Certificate password</label>
              <input
                style={inputStyle}
                type="password"
                value={certificatePassword}
                onChange={(e) => setCertificatePassword(e.target.value)}
              />

              {signingSource === 'apple' ?
                <>
                  <label style={labelStyle}>Apple ID</label>
                  <input
                    style={inputStyle}
                    type="email"
                    autoComplete="username"
                    placeholder="you@example.com"
                    value={appleAccount}
                    onChange={(e) => setAppleAccount(e.target.value)}
                  />
                  <label style={labelStyle}>Apple ID password</label>
                  <input
                    style={inputStyle}
                    type="password"
                    autoComplete="current-password"
                    value={applePassword}
                    onChange={(e) => setApplePassword(e.target.value)}
                  />
                  <button
                    style={secondaryButton(!appleAccount || !applePassword || appleBusy === 'login')}
                    onClick={signInWithApple}
                    disabled={!appleAccount || !applePassword || appleBusy === 'login'}
                  >
                    {appleBusy === 'login' ? 'Signing in...' : `Sign in (${appleLogin.status})`}
                  </button>

                  {appleLogin.status === 'two-factor-required' && (
                    <>
                      <label style={labelStyle}>Two-factor code</label>
                      <input
                        style={inputStyle}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        placeholder="123456"
                        value={twoFactorCode}
                        onChange={(e) => setTwoFactorCode(e.target.value)}
                      />
                      <button
                        style={secondaryButton(!twoFactorCode || appleBusy === '2fa')}
                        onClick={submitAppleTwoFactor}
                        disabled={!twoFactorCode || appleBusy === '2fa'}
                      >
                        {appleBusy === '2fa' ? 'Verifying...' : 'Submit code'}
                      </button>
                    </>
                  )}

                  {appleLogin.session && (
                    <>
                      <label style={labelStyle}>Team</label>
                      <select
                        style={inputStyle}
                        value={selectedTeamId}
                        disabled={resources.teams.length === 0}
                        onChange={(e) => {
                          const value = e.currentTarget.value;
                          setSelectedTeamId(value);
                          const team = resources.teams.find((t) => appleTeamSelectionId(t) === value);
                          const teamId = appleTeamSelectionId(team);
                          if (teamId) void loadAppleResources(teamId);
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

                      <label style={labelStyle}>Bundle ID resource</label>
                      <select
                        style={inputStyle}
                        value={selectedAppIdId}
                        disabled={resources.appIds.length === 0}
                        onChange={(e) => setSelectedAppIdId(e.currentTarget.value)}
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
                      <button
                        style={secondaryButton(!canUseApple || !bundleId.trim() || appleBusy === 'bundle')}
                        onClick={createBundleIdResource}
                        disabled={!canUseApple || !bundleId.trim() || appleBusy === 'bundle'}
                      >
                        {appleBusy === 'bundle' ? 'Creating...' : 'Create bundle ID'}
                      </button>

                      <label style={labelStyle}>Apple devices</label>
                      <select
                        multiple
                        style={{ ...inputStyle, height: '88px' }}
                        value={selectedDeviceIds}
                        onChange={(e) =>
                          setSelectedDeviceIds(
                            Array.from(e.currentTarget.selectedOptions).map((option) => option.value),
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
                      <button
                        style={secondaryButton(
                          !canUseApple || !deviceUDID || appleBusy === 'register-device',
                        )}
                        onClick={registerSelectedIPhone}
                        disabled={!canUseApple || !deviceUDID || appleBusy === 'register-device'}
                      >
                        {appleBusy === 'register-device' ?
                          'Registering...'
                        : 'Register selected iPhone'}
                      </button>

                      <label style={labelStyle}>Certificate</label>
                      <select
                        style={inputStyle}
                        value={certificateChoice}
                        onChange={(e) => setCertificateChoice(e.currentTarget.value as CertificateChoice)}
                      >
                        <option value="stored" disabled={!storedCertificate}>
                          Use stored local certificate
                        </option>
                        <option value="create">Create new certificate</option>
                      </select>

                      <label style={labelStyle}>Provisioning profile</label>
                      <select
                        style={inputStyle}
                        value={profileChoice}
                        onChange={(e) => setProfileChoice(e.currentTarget.value as ProfileChoice)}
                      >
                        <option value="create">Create new profile</option>
                        <option value="existing" disabled={!selectedProfile}>
                          Use selected existing profile
                        </option>
                      </select>
                      {profileChoice === 'existing' && (
                        <select
                          style={inputStyle}
                          value={selectedProfileId}
                          disabled={resources.profiles.length === 0}
                          onChange={(e) => setSelectedProfileId(e.currentTarget.value)}
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
                      )}

                      <button
                        style={primaryButton(!canUseApple || signing)}
                        onClick={prepareAppleSigning}
                        disabled={!canUseApple || signing}
                      >
                        {appleBusy === 'signing' ? 'Preparing...' : 'Prepare Apple signing assets'}
                      </button>
                    </>
                  )}
                </>
              : <>
                  <label style={labelStyle}>Certificate (.p12)</label>
                  <input
                    type="file"
                    accept=".p12,application/x-pkcs12"
                    onChange={(e) => setCertificateFile(e.currentTarget.files?.[0])}
                  />
                  <label style={labelStyle}>Provisioning profile (.mobileprovision)</label>
                  <input
                    type="file"
                    accept=".mobileprovision"
                    onChange={(e) => setProvisioningProfileFile(e.currentTarget.files?.[0])}
                  />
                  <button style={secondaryButton(signing)} onClick={prepareSigning} disabled={signing}>
                    {signing ? 'Preparing...' : 'Prepare signing assets'}
                  </button>
                </>
              }
              {signingAssets && <div style={infoBox}>Signing assets ready for {signingAssets.bundleID}.</div>}
            </Section>

            {/* Step 3: build */}
            <Section title="4. Build">
              <div style={hintText}>
                Make sure you ran <code>lim xcode sync . --id {sandbox.id}</code> first — builds run against
                the synced source.
              </div>
              <button
                style={primaryButton(!signingAssets || build.status === 'running' || build.status === 'queued')}
                onClick={startBuild}
                disabled={!signingAssets || build.status === 'running' || build.status === 'queued'}
              >
                {build.status === 'running' || build.status === 'queued' ?
                  `Building (${build.status})...`
                : 'Build signed IPA'}
              </button>
              <div style={infoBox}>Build status: {build.status}</div>
            </Section>

            {/* Step 4: install */}
            <Section title="5. Install">
              <button
                style={primaryButton(!install.canInstall || build.status !== 'succeeded')}
                onClick={startInstall}
                disabled={!install.canInstall || build.status !== 'succeeded'}
              >
                {install.busyAction === 'install' ? 'Installing...' : 'Install onto iPhone'}
              </button>
            </Section>
          </>
        )}

        {(error || install.error || build.error) && (
          <div style={errorBox}>{error || install.error || build.error}</div>
        )}
      </div>

      {/* Main area: progress + logs */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '24px', minWidth: 0 }}>
        <Stepper steps={steps} />

        <div style={{ display: 'flex', gap: '20px', flex: 1, minHeight: 0 }}>
          <LogPanel title="Build log">
            {build.logs.length === 0 ?
              <span style={{ color: '#999' }}>No build output yet.</span>
            : build.logs.map((line, i) => (
                <div key={i} style={{ color: line.type === 'stderr' ? '#c33' : '#222' }}>
                  {line.data}
                </div>
              ))
            }
          </LogPanel>

          <LogPanel title="Activity">
            {log.length === 0 ?
              <span style={{ color: '#999' }}>Nothing yet.</span>
            : log.map((entry, i) => (
                <div key={i}>
                  <span style={{ color: '#999' }}>{entry.at} </span>
                  {entry.message}
                  {entry.detail ? <span style={{ color: '#666' }}> — {entry.detail}</span> : null}
                </div>
              ))
            }
          </LogPanel>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ fontSize: '13px', fontWeight: 600, color: '#444' }}>{title}</div>
      {children}
    </div>
  );
}

function Stepper({ steps }: { steps: { label: string; done: boolean; active: boolean }[] }) {
  return (
    <div style={{ display: 'flex', gap: '8px', marginBottom: '20px', flexWrap: 'wrap' }}>
      {steps.map((step) => (
        <div
          key={step.label}
          style={{
            padding: '8px 14px',
            borderRadius: '999px',
            fontSize: '13px',
            fontWeight: 500,
            backgroundColor: step.done ? '#e8f5e9' : step.active ? '#e3f2fd' : '#f0f0f0',
            color: step.done ? '#2e7d32' : step.active ? '#1565c0' : '#999',
            border: `1px solid ${step.done ? '#a5d6a7' : step.active ? '#90caf9' : '#e0e0e0'}`,
          }}
        >
          {step.done ? '✓ ' : ''}
          {step.label}
        </div>
      ))}
    </div>
  );
}

function LogPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div style={{ fontSize: '13px', fontWeight: 600, color: '#444', marginBottom: '8px' }}>{title}</div>
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          backgroundColor: '#0d1117',
          color: '#c9d1d9',
          borderRadius: '8px',
          padding: '12px',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: '12px',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {children}
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = { fontSize: '13px', fontWeight: 500, color: '#444' };

const tabRow: React.CSSProperties = {
  display: 'flex',
  gap: '6px',
  padding: '4px',
  backgroundColor: '#eef0f2',
  borderRadius: '8px',
};

function tabButton(active: boolean): React.CSSProperties {
  return {
    flex: 1,
    padding: '8px',
    fontSize: '13px',
    fontWeight: 600,
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    backgroundColor: active ? '#fff' : 'transparent',
    color: active ? '#1565c0' : '#666',
    boxShadow: active ? '0 1px 2px rgba(0,0,0,0.1)' : 'none',
  };
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px',
  border: '1px solid #ddd',
  borderRadius: '6px',
  fontSize: '14px',
  boxSizing: 'border-box',
};

const infoBox: React.CSSProperties = {
  padding: '10px',
  backgroundColor: '#e8f5e9',
  color: '#2e7d32',
  borderRadius: '6px',
  fontSize: '13px',
};

const warnBox: React.CSSProperties = {
  padding: '10px',
  backgroundColor: '#fff8e1',
  color: '#8a6d00',
  borderRadius: '6px',
  fontSize: '13px',
};

const hintText: React.CSSProperties = {
  fontSize: '12px',
  color: '#666',
  lineHeight: 1.5,
};

const codeBlock: React.CSSProperties = {
  margin: '8px 0 4px',
  padding: '8px 10px',
  backgroundColor: '#0d1117',
  color: '#c9d1d9',
  borderRadius: '6px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '12px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
};

const errorBox: React.CSSProperties = {
  padding: '12px',
  backgroundColor: '#fee',
  color: '#c33',
  borderRadius: '6px',
  fontSize: '13px',
};

function baseButton(disabled: boolean): React.CSSProperties {
  return {
    width: '100%',
    padding: '12px',
    fontSize: '14px',
    fontWeight: 500,
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'background-color 0.2s',
  };
}

function primaryButton(disabled: boolean): React.CSSProperties {
  return { ...baseButton(disabled), backgroundColor: disabled ? '#ccc' : '#0066ff' };
}

function secondaryButton(disabled: boolean): React.CSSProperties {
  return { ...baseButton(disabled), backgroundColor: disabled ? '#ccc' : '#444' };
}

function dangerButton(disabled: boolean): React.CSSProperties {
  return { ...baseButton(disabled), backgroundColor: disabled ? '#ccc' : '#dc3545' };
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

export default App;
