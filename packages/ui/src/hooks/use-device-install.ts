import { useCallback, useEffect, useRef, useState } from 'react';
import {
  closeDeviceRelayTarget,
  createBundleIDRequest,
  createDevelopmentProfileRequest,
  downloadCertificateRequest,
  downloadProfileRequest,
  exportAppleCertificateP12,
  fetchLimbuildInfo,
  findDevelopmentCertificatesRequest,
  findBundleIDRequest,
  findDeviceRequest,
  findDevelopmentProfilesRequest,
  generateAppleSigningKeyAndCSR,
  getPairRecord,
  getLatestSigningAssets,
  getLatestSigningAssetsWithCertificate,
  getReusableAppleSigningAssets,
  listTeamsRequest,
  parseProvisioningProfile,
  parseProvisioningProfileBase64,
  profileContainsDevice,
  profileMatchesBundleID,
  proxyProvisioningRequest,
  putAppleGeneratedSigningAssets,
  putPairRecord,
  putSigningAssets,
  registerDeviceRequest,
  requestUSBAccess as requestDeviceUSBAccess,
  startBrowserOwnedAppleIDLogin,
  startSignedDeviceBuild,
  startInstallRelay,
  startPairingRelay,
  submitDevelopmentCSRRequest,
  watchBuildLogEvents,
  type AppleIDLoginResult,
  type AppleDeveloperPortalDevice,
  type AppleDeveloperPortalAppID,
  type AppleDeveloperPortalResponse,
  type AppleDeveloperPortalTeam,
  type BuildLogLine,
  type DeviceInstallBuildStatus,
  type DeviceInstallBusyAction,
  type DeviceInstallStep,
  type DeviceInstallStepStatus,
  type DeviceRelayTarget,
  type StoredPairRecord,
  type StoredSigningAssets,
} from '../core/device-install';
import type { RelayClient } from '../core/device-install/operations';

type DeviceInstallStepStatuses = Record<DeviceInstallStep, DeviceInstallStepStatus>;

type ReusableAppleCertificate = Pick<
  StoredSigningAssets,
  'certificateID' | 'certificateP12Base64' | 'certificatePassword' | 'teamID'
> & {
  certificateID: string;
};

export type UseDeviceInstallOptions = {
  apiUrl?: string;
  token?: string;
};

export type UseDeviceInstallResult = {
  currentStep: DeviceInstallStep;
  stepStatuses: DeviceInstallStepStatuses;
  device?: DeviceInstallDevice;
  hasPairRecord: boolean;
  hasSigningAssets: boolean;
  hasSigningInputs: boolean;
  pairConfirmationRequired: boolean;
  logs: string[];
  buildLogs: BuildLogLine[];
  buildStatus: DeviceInstallBuildStatus;
  appleSigningStatus: DeviceInstallAppleSigningStatus;
  appleTeams: AppleDeveloperPortalTeam[];
  appleDevices: AppleDeveloperPortalDevice[];
  appleAppIDs: AppleDeveloperPortalAppID[];
  applePortalSummary?: ApplePortalSummary;
  selectedAppleTeamID?: string;
  selectedAppleDeviceIDs: string[];
  connectedAppleDeviceRegistered: boolean;
  connectedDeviceInProfile?: boolean;
  hasReusableAppleCertificate: boolean;
  appleBundleID: string;
  buildLogPanelOpen: boolean;
  busyAction?: DeviceInstallBusyAction;
  error?: string;
  canBuild: boolean;
  canPrepareAppleSigningAssets: boolean;
  canRequestUSBAccess: boolean;
  canPairBrowser: boolean;
  canInstall: boolean;
  setSigningFiles: (files: DeviceInstallSigningFiles) => void;
  setAppleBundleID: (bundleID: string) => void;
  setSelectedAppleDeviceIDs: (deviceIDs: string[]) => void;
  setBuildLogPanelOpen: (open: boolean) => void;
  startAppleIDLogin: (input: DeviceInstallAppleIDLoginInput) => Promise<void>;
  submitAppleTwoFactorCode: (code: string) => Promise<void>;
  setSelectedAppleTeamID: (teamID: string | undefined) => void;
  clearAppleIDLogin: () => void;
  registerConnectedAppleDevice: () => Promise<void>;
  prepareAppleSigningAssets: () => Promise<void>;
  startDeviceBuild: () => Promise<void>;
  requestUSBAccess: () => Promise<void>;
  pairBrowser: () => Promise<void>;
  startInstallation: () => Promise<void>;
  stopRelay: () => void;
};

export type DeviceInstallAppleSigningStatus =
  | 'idle'
  | 'authenticating'
  | 'two-factor-required'
  | 'authenticated'
  | 'preparing-assets'
  | 'assets-ready'
  | 'using-cached-profile'
  | 'error';

export type DeviceInstallDevice = {
  serialNumber?: string;
  productName?: string;
  manufacturerName?: string;
};

export type DeviceInstallSigningFiles = {
  certificateFile?: File;
  provisioningProfileFile?: File;
  certificatePassword?: string;
};

export type DeviceInstallAppleIDLoginInput = {
  accountName: string;
  password: string;
};

export type ApplePortalSummary = {
  certificateCount: number;
  profileCount: number;
};

const initialStepStatuses: DeviceInstallStepStatuses = {
  signing: 'idle',
  connect: 'idle',
  build: 'idle',
  install: 'idle',
};

export function useDeviceInstall({
  apiUrl,
  token,
}: UseDeviceInstallOptions): UseDeviceInstallResult {
  const [currentStep, setCurrentStep] = useState<DeviceInstallStep>('signing');
  const [stepStatuses, setStepStatuses] = useState<DeviceInstallStepStatuses>(initialStepStatuses);
  const [selectedDevice, setSelectedDevice] = useState<DeviceRelayTarget | undefined>();
  const [pairRecord, setPairRecord] = useState<StoredPairRecord | undefined>();
  const [signingAssets, setSigningAssets] = useState<StoredSigningAssets | undefined>();
  const [logs, setLogs] = useState<string[]>([
    'Ready. Prepare signing assets, build, connect and pair the iPhone, then install.',
  ]);
  const [buildLogs, setBuildLogs] = useState<BuildLogLine[]>([]);
  const [buildStatus, setBuildStatus] = useState<DeviceInstallBuildStatus>('idle');
  const [appleSigningStatus, setAppleSigningStatus] = useState<DeviceInstallAppleSigningStatus>('idle');
  const [appleTeams, setAppleTeams] = useState<AppleDeveloperPortalTeam[]>([]);
  const [appleDevices, setAppleDevices] = useState<AppleDeveloperPortalDevice[]>([]);
  const [appleAppIDs, setAppleAppIDs] = useState<AppleDeveloperPortalAppID[]>([]);
  const [selectedAppleDeviceIDs, setSelectedAppleDeviceIDs] = useState<string[]>([]);
  const [applePortalSummary, setApplePortalSummary] = useState<ApplePortalSummary | undefined>();
  const [selectedAppleTeamID, setSelectedAppleTeamID] = useState<string | undefined>();
  const [appleBundleID, setAppleBundleID] = useState('');
  const [reusableAppleCertificate, setReusableAppleCertificate] = useState<ReusableAppleCertificate | undefined>();
  const [buildLogPanelOpen, setBuildLogPanelOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<DeviceInstallBusyAction | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [pairConfirmationRequired, setPairConfirmationRequired] = useState(false);
  const [signingFiles, setSigningFilesState] = useState<DeviceInstallSigningFiles>({});
  const relayRef = useRef<RelayClient | undefined>(undefined);
  const selectedDeviceRef = useRef<DeviceRelayTarget | undefined>(undefined);
  const stopBuildWatcherRef = useRef<(() => void) | undefined>(undefined);
  const appleIDLoginRef = useRef<AppleIDLoginResult | undefined>(undefined);

  const log = useCallback((message: string, detail?: string) => {
    const line = detail ? `${message}\n${detail}` : message;
    setLogs((current) => [line, ...current].slice(0, 100));
  }, []);

  const setStepStatus = useCallback((step: DeviceInstallStep, status: DeviceInstallStepStatus) => {
    setStepStatuses((current) => ({ ...current, [step]: status }));
  }, []);

  const setSigningFiles = useCallback((files: DeviceInstallSigningFiles) => {
    setSigningFilesState((current) => {
      const next = { ...current, ...files };
      const ready = !!next.certificateFile && !!next.provisioningProfileFile && !!next.certificatePassword;
      setStepStatus('signing', ready ? 'complete' : 'active');
      if (ready) {
        setAppleSigningStatus('assets-ready');
        setCurrentStep('build');
      }
      return next;
    });
    setSigningAssets(undefined);
  }, [setStepStatus]);

  useEffect(() => {
    let cancelled = false;
    void getLatestSigningAssets().then((stored) => {
      if (cancelled || !stored) return;
      setSigningAssets(stored);
      setAppleBundleID(stored.bundleID);
      setAppleSigningStatus('using-cached-profile');
      setStepStatus('signing', 'complete');
      setCurrentStep('build');
      log('Using stored signing assets', stored.bundleID);
    });
    return () => {
      cancelled = true;
    };
  }, [log, setStepStatus]);

  const selectedDeveloperTeamID = useCallback(() => {
    return developerPortalTeamID(appleTeams.find((team) => appleTeamSelectionID(team) === selectedAppleTeamID));
  }, [appleTeams, selectedAppleTeamID]);

  useEffect(() => {
    const teamID = selectedDeveloperTeamID();
    if (!teamID) {
      setReusableAppleCertificate(undefined);
      return;
    }
    let cancelled = false;
    void findReusableAppleCertificate(teamID).then((certificate) => {
      if (!cancelled) {
        setReusableAppleCertificate(certificate);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [selectedDeveloperTeamID]);

  const connectedAppleDevice = selectedDevice?.hello.serialNumber
    ? appleDevices.find((device) => normalizeAppleUDID(device.deviceNumber) === normalizeAppleUDID(selectedDevice.hello.serialNumber))
    : undefined;
  const connectedAppleDeviceRegistered = !!connectedAppleDevice?.deviceId;
  const manualSigningFilesReady =
    !!signingFiles.certificateFile && !!signingFiles.provisioningProfileFile && !!signingFiles.certificatePassword;
  const signingInputsReady = !!signingAssets || manualSigningFilesReady;
  const connectedDeviceInProfile =
    selectedDevice?.hello.serialNumber && signingAssets
      ? profileContainsDevice(signingAssets.profile, selectedDevice.hello.serialNumber)
      : undefined;

  useEffect(() => {
    selectedDeviceRef.current = selectedDevice;
  }, [selectedDevice]);

  const cleanupDeviceAccess = useCallback(async () => {
    relayRef.current?.close();
    relayRef.current = undefined;
    await closeDeviceRelayTarget(selectedDeviceRef.current, log);
  }, [log]);

  useEffect(() => {
    return () => {
      stopBuildWatcherRef.current?.();
      void appleIDLoginRef.current?.close();
      appleIDLoginRef.current = undefined;
      void cleanupDeviceAccess();
    };
  }, [cleanupDeviceAccess]);

  const resolveSigningAssetsForBuild = useCallback(async () => {
    const requestedBundleID = appleBundleID.trim();
    if (!requestedBundleID || (signingAssets && profileMatchesBundleID(signingAssets.profile, requestedBundleID))) {
      if (signingAssets) {
        log('Using prepared signing assets', signingAssets.bundleID);
        return signingAssets;
      }
    }
    const info = requestedBundleID ? undefined : apiUrl ? await fetchStoredBuildInfo(apiUrl, token).catch(() => undefined) : undefined;
    const bundleID = requestedBundleID || info?.lastBuildConfig?.bundleId;
    if (bundleID) {
      const cached = await getReusableAppleSigningAssets({
        bundleID,
        deviceUDID: selectedDevice?.hello.serialNumber,
        teamID: selectedDeveloperTeamID(),
      });
      if (cached) {
        setAppleSigningStatus('using-cached-profile');
        log('Using cached Apple signing profile', cached.bundleID);
        setSigningAssets(cached);
        return cached;
      }
    }
    const stored = await getLatestSigningAssets();
    if (stored) {
      log('Using stored signing assets', stored.bundleID);
      setSigningAssets(stored);
      return stored;
    }
    if (
      !signingFiles.certificateFile ||
      !signingFiles.provisioningProfileFile ||
      !signingFiles.certificatePassword
    ) {
      throw new Error('Upload a certificate, provisioning profile, and certificate password.');
    }
    log('Preparing signing assets');
    const [certificateP12Base64, provisioningProfileBase64, profile] = await Promise.all([
      fileToBase64(signingFiles.certificateFile),
      fileToBase64(signingFiles.provisioningProfileFile),
      parseProvisioningProfile(signingFiles.provisioningProfileFile),
    ]);
    if (selectedDevice?.hello.serialNumber && !profileContainsDevice(profile, selectedDevice.hello.serialNumber)) {
      throw new Error('Provisioning profile does not include the selected iPhone.');
    }
    const storageBundleId = profile.bundleID ?? profile.applicationIdentifier ?? signingFiles.provisioningProfileFile.name;
    const storedAssets = await putSigningAssets({
      deviceUDID: selectedDevice?.hello.serialNumber,
      bundleID: storageBundleId,
      certificateP12Base64,
      certificateFileName: signingFiles.certificateFile.name,
      certificatePassword: signingFiles.certificatePassword,
      provisioningProfileBase64,
      profileFileName: signingFiles.provisioningProfileFile.name,
      profile,
    });
    setSigningAssets(storedAssets);
    log('Signing assets stored locally', storageBundleId);
    return storedAssets;
  }, [apiUrl, appleBundleID, log, selectedDeveloperTeamID, selectedDevice?.hello.serialNumber, signingAssets, signingFiles, token]);

  const startAppleIDLogin = useCallback(
    async ({ accountName, password }: DeviceInstallAppleIDLoginInput) => {
      if (!apiUrl) return;
      setBusyAction('signing');
      setError(undefined);
      setCurrentStep('signing');
      setStepStatus('signing', 'active');
      setAppleSigningStatus('authenticating');
      try {
        await appleIDLoginRef.current?.close().catch(() => undefined);
        const session = await startBrowserOwnedAppleIDLogin({ limbuildApiUrl: apiUrl, token, accountName, password });
        appleIDLoginRef.current = session;
        if (!session.requiresTwoFactor) {
          const accountSession = await session.finalize().catch(() => undefined);
          const teamID = await refreshAppleTeams(
            apiUrl,
            session.appleSessionId,
            token,
            setAppleTeams,
            setSelectedAppleTeamID,
            accountSession?.body as AppleDeveloperPortalResponse | undefined,
          );
          await refreshAppleAppIDs(apiUrl, session.appleSessionId, token, teamID, setAppleAppIDs, setAppleBundleID);
          if (teamID) {
            await refreshAppleDevices({
              apiUrl,
              token,
              appleSessionId: session.appleSessionId,
              teamID,
              setAppleDevices,
              setSelectedAppleDeviceIDs,
              log,
            });
          }
          await refreshApplePortalSummary(apiUrl, session.appleSessionId, token, teamID, setApplePortalSummary, log);
        }
        setAppleSigningStatus(session.requiresTwoFactor ? 'two-factor-required' : 'authenticated');
        log(
          session.requiresTwoFactor ? 'Apple ID requires two-factor authentication' : 'Apple ID authenticated',
          accountName,
        );
      } catch (caught) {
        const message = errorMessage(caught);
        setError(message);
        setAppleSigningStatus('error');
        log('Apple ID authentication failed', message);
      } finally {
        setBusyAction(undefined);
      }
    },
    [apiUrl, log, setStepStatus, token],
  );

  const submitAppleTwoFactorCode = useCallback(
    async (code: string) => {
      const session = appleIDLoginRef.current;
      if (!session) {
        throw new Error('Start Apple ID login before submitting a two-factor code.');
      }
      setBusyAction('signing');
      setError(undefined);
      setCurrentStep('signing');
      setStepStatus('signing', 'active');
      try {
        await session.finishTwoFactor(code);
        if (apiUrl) {
          const accountSession = await session.finalize().catch(() => undefined);
          const teamID = await refreshAppleTeams(
            apiUrl,
            session.appleSessionId,
            token,
            setAppleTeams,
            setSelectedAppleTeamID,
            accountSession?.body as AppleDeveloperPortalResponse | undefined,
          );
          await refreshAppleAppIDs(apiUrl, session.appleSessionId, token, teamID, setAppleAppIDs, setAppleBundleID);
          if (teamID) {
            await refreshAppleDevices({
              apiUrl,
              token,
              appleSessionId: session.appleSessionId,
              teamID,
              setAppleDevices,
              setSelectedAppleDeviceIDs,
              log,
            });
          }
          await refreshApplePortalSummary(apiUrl, session.appleSessionId, token, teamID, setApplePortalSummary, log);
        }
        setAppleSigningStatus('authenticated');
        log('Apple ID two-factor authentication accepted');
      } catch (caught) {
        const message = errorMessage(caught);
        setError(message);
        setAppleSigningStatus('error');
        log('Apple ID two-factor authentication failed', message);
      } finally {
        setBusyAction(undefined);
      }
    },
    [apiUrl, log, setStepStatus, token],
  );

  const clearAppleIDLogin = useCallback(() => {
    void appleIDLoginRef.current?.close();
    appleIDLoginRef.current = undefined;
    setAppleTeams([]);
    setAppleDevices([]);
    setAppleAppIDs([]);
    setSelectedAppleDeviceIDs([]);
    setApplePortalSummary(undefined);
    setSelectedAppleTeamID(undefined);
    setReusableAppleCertificate(undefined);
    setAppleSigningStatus('idle');
    setStepStatus('signing', 'idle');
    log('Apple ID login state cleared');
  }, [log, setStepStatus]);

  const selectAppleTeam = useCallback(
    (teamID: string | undefined) => {
      setSelectedAppleTeamID(teamID);
      setAppleAppIDs([]);
      setAppleDevices([]);
      setSelectedAppleDeviceIDs([]);
      setApplePortalSummary(undefined);
      setAppleBundleID('');
      setSigningAssets(undefined);
      const session = appleIDLoginRef.current;
      if (!apiUrl || !session || !teamID) return;
      const developerTeamID = developerPortalTeamID(appleTeams.find((team) => appleTeamSelectionID(team) === teamID));
      if (!developerTeamID) return;
      void (async () => {
        try {
          await refreshAppleAppIDs(apiUrl, session.appleSessionId, token, developerTeamID, setAppleAppIDs, setAppleBundleID);
          await refreshApplePortalSummary(apiUrl, session.appleSessionId, token, developerTeamID, setApplePortalSummary, log);
          await refreshAppleDevices({
            apiUrl,
            token,
            appleSessionId: session.appleSessionId,
            teamID: developerTeamID,
            connectedUDID: selectedDeviceRef.current?.hello.serialNumber,
            setAppleDevices,
            setSelectedAppleDeviceIDs,
            log,
          });
        } catch (caught) {
          const message = errorMessage(caught);
          setError(message);
          log('Apple team refresh failed', message);
        }
      })();
    },
    [apiUrl, appleTeams, log, token],
  );

  const registerConnectedAppleDevice = useCallback(async () => {
    const teamID = selectedDeveloperTeamID();
    if (!apiUrl || !appleIDLoginRef.current || !selectedDevice?.hello.serialNumber || !teamID) return;
    setBusyAction('signing');
    setError(undefined);
    try {
      const normalizedUDID = normalizeAppleUDID(selectedDevice.hello.serialNumber);
      const created = await proxyProvisioningRequest<AppleDeveloperPortalResponse>(
        apiUrl,
        appleIDLoginRef.current.appleSessionId,
        registerDeviceRequest({
          deviceUDID: normalizedUDID,
          teamID,
          name: selectedDevice.hello.productName ?? 'Limrun iPhone',
        }),
        token,
      );
      assertApplePortalResponseOK(created.body, 'Apple device registration');
      await refreshAppleDevices({
        apiUrl,
        token,
        appleSessionId: appleIDLoginRef.current.appleSessionId,
        teamID,
        connectedUDID: selectedDevice.hello.serialNumber,
        setAppleDevices,
        setSelectedAppleDeviceIDs,
        log,
      });
      log('Connected iPhone registered with Apple Developer', normalizedUDID);
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      log('Apple device registration failed', message);
    } finally {
      setBusyAction(undefined);
    }
  }, [apiUrl, log, selectedDeveloperTeamID, selectedDevice?.hello.productName, selectedDevice?.hello.serialNumber, token]);

  const prepareAppleSigningAssets = useCallback(async () => {
    if (!apiUrl || !appleIDLoginRef.current) return;
    const bundleID = appleBundleID.trim();
    if (!bundleID) {
      throw new Error('Enter a bundle ID before preparing signing assets.');
    }
    if (!selectedAppleTeamID) {
      throw new Error('Select an Apple Developer team before preparing signing assets.');
    }
    const teamID = selectedDeveloperTeamID();
    if (!teamID) {
      throw new Error('Selected Apple team does not include a Developer Portal team ID.');
    }
    if (selectedAppleDeviceIDs.length === 0) {
      throw new Error('Select at least one Apple Developer device before preparing signing assets.');
    }
    if (!reusableAppleCertificate && !signingFiles.certificatePassword) {
      throw new Error('Enter a .p12 password before preparing signing assets.');
    }
    const selectedPortalDevice = appleDevices.find(
      (device) => !!device.deviceNumber && selectedAppleDeviceIDs.includes(device.deviceId ?? ''),
    );
    const signingDeviceUDID = selectedDevice?.hello.serialNumber ?? selectedPortalDevice?.deviceNumber;
    setBusyAction('signing');
    setError(undefined);
    setCurrentStep('signing');
    setStepStatus('signing', 'active');
    setAppleSigningStatus('preparing-assets');
    try {
      const cached = await getReusableAppleSigningAssets({
        bundleID,
        deviceUDID: signingDeviceUDID,
        teamID,
      });
      if (cached) {
        setSigningAssets(cached);
        setAppleSigningStatus('assets-ready');
        setStepStatus('signing', 'complete');
        setCurrentStep('build');
        log('Using cached Apple signing assets', bundleID);
        return;
      }
      const assets = await prepareAppleSigningAssetsForDevice({
        apiUrl,
        token,
        appleSessionId: appleIDLoginRef.current.appleSessionId,
        teamID,
        bundleID,
        deviceUDID: signingDeviceUDID,
        deviceIDs: selectedAppleDeviceIDs,
        certificatePassword: signingFiles.certificatePassword,
        reusableCertificate: reusableAppleCertificate,
      });
      setSigningAssets(assets);
      setAppleSigningStatus('assets-ready');
      setStepStatus('signing', 'complete');
      setCurrentStep('build');
      log(
        'Apple signing assets stored locally',
        signingDeviceUDID ? `${bundleID} for ${signingDeviceUDID}` : `${bundleID} for selected Apple devices`,
      );
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      setAppleSigningStatus('error');
      log('Apple signing asset preparation failed', message);
    } finally {
      setBusyAction(undefined);
    }
  }, [
    apiUrl,
    appleBundleID,
    appleDevices,
    appleTeams,
    log,
    selectedAppleTeamID,
    selectedAppleDeviceIDs,
    selectedDeveloperTeamID,
    selectedDevice?.hello.serialNumber,
    setStepStatus,
    reusableAppleCertificate,
    signingFiles.certificatePassword,
    token,
  ]);

  const startDeviceBuild = useCallback(async () => {
    if (!apiUrl) return;
    setBusyAction('build');
    setError(undefined);
    setCurrentStep('build');
    setStepStatus('build', 'active');
    setBuildLogPanelOpen(true);
    setBuildLogs([]);
    setBuildStatus('queued');
    stopBuildWatcherRef.current?.();
    try {
      const assets = await resolveSigningAssetsForBuild();
      log('Starting signed device build');
      const result = await startSignedDeviceBuild({
        limbuildApiUrl: apiUrl,
        token,
        certificateP12Base64: assets.certificateP12Base64,
        certificatePassword: assets.certificatePassword,
        provisioningProfileBase64: assets.provisioningProfileBase64,
      });
      if (!result.execId) {
        throw new Error('Build request did not return an exec ID.');
      }
      log('Signed device build started', result.execId);
      stopBuildWatcherRef.current = watchBuildLogEvents({
        limbuildApiUrl: apiUrl,
        execId: result.execId,
        token,
        onLine: (line) => setBuildLogs((current) => [...current, line]),
        onStatus: (status) => {
          setBuildStatus(status);
          if (status === 'succeeded') {
            setStepStatus('build', 'complete');
            setStepStatus('connect', 'active');
            setCurrentStep('connect');
          } else if (status === 'failed' || status === 'cancelled') {
            setStepStatus('build', 'error');
          }
        },
        onError: (caught) => {
          const message = errorMessage(caught);
          setError(message);
          log('Build log stream failed', message);
        },
      });
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      setBuildStatus('failed');
      setStepStatus('build', 'error');
      log('Signed device build failed', message);
    } finally {
      setBusyAction(undefined);
    }
  }, [apiUrl, log, resolveSigningAssetsForBuild, setStepStatus, token]);

  const requestUSBAccess = useCallback(async () => {
    setBusyAction('usb');
    setError(undefined);
    setCurrentStep('connect');
    setStepStatus('connect', 'active');
    let target: DeviceRelayTarget | undefined;
    try {
      await cleanupDeviceAccess();
      target = await requestDeviceUSBAccess({ log });
      setPairConfirmationRequired(false);
      const storedPairRecord = await getPairRecord(target.hello.serialNumber);
      const activeSigningAssets = signingAssets ?? (manualSigningFilesReady ? undefined : await getLatestSigningAssets());
      if (activeSigningAssets) {
        if (!profileContainsDevice(activeSigningAssets.profile, target.hello.serialNumber)) {
          throw new Error('Stored provisioning profile does not include the selected iPhone.');
        }
        setSigningAssets(activeSigningAssets);
      }
      if (apiUrl && appleIDLoginRef.current) {
        const teamID = selectedDeveloperTeamID();
        if (teamID) {
          await refreshAppleDevices({
            apiUrl,
            token,
            appleSessionId: appleIDLoginRef.current.appleSessionId,
            teamID,
            connectedUDID: target.hello.serialNumber,
            setAppleDevices,
            setSelectedAppleDeviceIDs,
            log,
          });
        }
      }
      setSelectedDevice(target);
      setPairRecord(storedPairRecord);
      setStepStatus('connect', storedPairRecord ? 'complete' : 'active');
      setCurrentStep(storedPairRecord ? 'install' : 'connect');
      log(storedPairRecord ? 'Pair record found' : 'No pair record found', target.hello.serialNumber);
    } catch (caught) {
      await closeDeviceRelayTarget(target, log);
      setSelectedDevice(undefined);
      setPairRecord(undefined);
      const message = errorMessage(caught);
      setError(message);
      setStepStatus('connect', 'error');
      log('USB access failed', message);
    } finally {
      setBusyAction(undefined);
    }
  }, [apiUrl, cleanupDeviceAccess, log, manualSigningFilesReady, selectedDeveloperTeamID, setStepStatus, signingAssets, token]);

  const pairBrowser = useCallback(async () => {
    if (!apiUrl || !selectedDevice) return;
    setBusyAction('pair');
    setError(undefined);
    setPairConfirmationRequired(false);
    setCurrentStep('connect');
    setStepStatus('connect', 'active');
    try {
      await cleanupDeviceAccess();
      const result = await startPairingRelay({
        limbuildApiUrl: apiUrl,
        token,
        log,
        target: selectedDevice,
      });
      const stored = await putPairRecord(result.pairRecord, {
        productName: selectedDevice.hello.productName,
      });
      result.relay.close();
      await closeDeviceRelayTarget(selectedDevice, log);
      setPairRecord(stored);
      setPairConfirmationRequired(false);
      setStepStatus('connect', 'complete');
      setCurrentStep('install');
      log('Device paired', 'The pair record was stored locally in this browser.');
    } catch (caught) {
      await closeDeviceRelayTarget(selectedDevice, log);
      const message = errorMessage(caught);
      setPairConfirmationRequired(true);
      setError('Unlock the iPhone, tap Trust, then confirm the pair record.');
      setStepStatus('connect', 'error');
      log('Device pairing failed', message);
    } finally {
      setBusyAction(undefined);
    }
  }, [apiUrl, cleanupDeviceAccess, log, selectedDevice, setStepStatus, token]);

  const startInstallation = useCallback(async () => {
    if (!apiUrl || !selectedDevice || !pairRecord) return;
    setBusyAction('install');
    setError(undefined);
    setCurrentStep('install');
    setStepStatus('install', 'active');
    try {
      await cleanupDeviceAccess();
      relayRef.current = await startInstallRelay({
        limbuildApiUrl: apiUrl,
        token,
        log,
        target: selectedDevice,
        pairRecord,
      });
      setStepStatus('install', 'complete');
      log('Device install started', 'Installation will continue through the connected iPhone.');
    } catch (caught) {
      await closeDeviceRelayTarget(selectedDevice, log);
      const message = errorMessage(caught);
      setError(message);
      setStepStatus('install', 'error');
      log('Device install relay failed', message);
    } finally {
      setBusyAction(undefined);
    }
  }, [apiUrl, cleanupDeviceAccess, log, pairRecord, selectedDevice, setStepStatus, token]);

  const stopRelay = useCallback(() => {
    void cleanupDeviceAccess();
    log('Device relay stopped');
  }, [cleanupDeviceAccess, log]);

  return {
    currentStep,
    stepStatuses,
    device: selectedDevice?.hello,
    hasPairRecord: !!pairRecord,
    hasSigningAssets: !!signingAssets,
    hasSigningInputs: signingInputsReady,
    pairConfirmationRequired,
    logs,
    buildLogs,
    buildStatus,
    appleSigningStatus,
    appleTeams,
    appleDevices,
    appleAppIDs,
    applePortalSummary,
    selectedAppleTeamID,
    selectedAppleDeviceIDs,
    connectedAppleDeviceRegistered,
    connectedDeviceInProfile,
    hasReusableAppleCertificate: !!reusableAppleCertificate,
    appleBundleID,
    buildLogPanelOpen,
    busyAction,
    error,
    canBuild:
      !!apiUrl &&
      !busyAction &&
      signingInputsReady,
    canPrepareAppleSigningAssets:
      !!apiUrl &&
      !busyAction &&
      !!appleIDLoginRef.current &&
      !!appleBundleID.trim() &&
      !!selectedDeveloperTeamID() &&
      selectedAppleDeviceIDs.length > 0 &&
      (!!reusableAppleCertificate || !!signingFiles.certificatePassword),
    canRequestUSBAccess: !busyAction && buildStatus === 'succeeded',
    canPairBrowser: !!apiUrl && !busyAction && buildStatus === 'succeeded' && !!selectedDevice,
    canInstall: !!apiUrl && !busyAction && buildStatus === 'succeeded' && !!selectedDevice && !!pairRecord,
    setSigningFiles,
    setAppleBundleID,
    setSelectedAppleDeviceIDs,
    setBuildLogPanelOpen,
    startAppleIDLogin,
    submitAppleTwoFactorCode,
    setSelectedAppleTeamID: selectAppleTeam,
    clearAppleIDLogin,
    registerConnectedAppleDevice,
    prepareAppleSigningAssets,
    startDeviceBuild,
    requestUSBAccess,
    pairBrowser,
    startInstallation,
    stopRelay,
  };
}

async function fetchStoredBuildInfo(apiUrl: string, token?: string) {
  return fetchLimbuildInfo(apiUrl, token);
}

async function findReusableAppleCertificate(teamID: string): Promise<ReusableAppleCertificate | undefined> {
  const stored = await getLatestSigningAssetsWithCertificate(teamID);
  if (!stored?.certificateID || !stored.certificateP12Base64 || !stored.certificatePassword) {
    return undefined;
  }
  return {
    certificateID: stored.certificateID,
    certificateP12Base64: stored.certificateP12Base64,
    certificatePassword: stored.certificatePassword,
    teamID: stored.teamID,
  };
}

async function refreshAppleTeams(
  apiUrl: string,
  appleSessionId: string,
  token: string | undefined,
  setAppleTeams: (teams: AppleDeveloperPortalTeam[]) => void,
  setSelectedAppleTeamID: (teamID: string | undefined) => void,
  accountSession?: AppleDeveloperPortalResponse,
) {
  const response = await proxyProvisioningRequest<AppleDeveloperPortalResponse>(apiUrl, appleSessionId, listTeamsRequest(), token);
  assertApplePortalResponseOK(response.body, 'Apple Developer team list');
  const teams = uniqueAppleTeams([
    ...(response.body?.teams ?? []),
  ]);
  void accountSession;
  setAppleTeams(teams);
  const firstDeveloperTeam = teams.find((team) => developerPortalTeamID(team));
  const firstSelectionID = appleTeamSelectionID(firstDeveloperTeam ?? teams[0]);
  if (firstSelectionID) {
    setSelectedAppleTeamID(firstSelectionID);
  }
  if (teams.length === 0) {
    throw new Error('Apple Developer account did not return any teams or providers.');
  }
  return teams.map(developerPortalTeamID).find((teamID) => !!teamID);
}

function uniqueAppleTeams(teams: AppleDeveloperPortalTeam[]) {
  const seen = new Set<string>();
  const result: AppleDeveloperPortalTeam[] = [];
  for (const team of teams) {
    const id = appleTeamSelectionID(team);
    const key = id ?? team.name ?? JSON.stringify(team);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(team);
  }
  return result;
}

async function refreshAppleAppIDs(
  apiUrl: string,
  appleSessionId: string,
  token: string | undefined,
  teamID: string | undefined,
  setAppleAppIDs: (appIDs: AppleDeveloperPortalAppID[]) => void,
  setAppleBundleID: (bundleID: string) => void,
) {
  if (!teamID) return;
  const response = await proxyProvisioningRequest<AppleDeveloperPortalResponse>(
    apiUrl,
    appleSessionId,
    findBundleIDRequest({ bundleID: '', teamID }),
    token,
  );
  assertApplePortalResponseOK(response.body, 'Apple bundle ID list');
  const appIDs = response.body?.appIds ?? [];
  setAppleAppIDs(appIDs);
  const firstBundleID = bundleIDFromAppleAppID(appIDs[0]);
  if (firstBundleID) {
    setAppleBundleID(firstBundleID);
    return;
  }
  const info = await fetchStoredBuildInfo(apiUrl, token).catch(() => undefined);
  if (info?.lastBuildConfig?.bundleId) {
    setAppleBundleID(info.lastBuildConfig.bundleId);
  }
}

async function refreshApplePortalSummary(
  apiUrl: string,
  appleSessionId: string,
  token: string | undefined,
  teamID: string | undefined,
  setApplePortalSummary: (summary: ApplePortalSummary | undefined) => void,
  log: (message: string, detail?: string) => void,
) {
  const [certificates, profiles] = await Promise.all([
    proxyProvisioningRequest<AppleDeveloperPortalResponse>(
      apiUrl,
      appleSessionId,
      findDevelopmentCertificatesRequest(teamID ?? ''),
      token,
    ),
    proxyProvisioningRequest<AppleDeveloperPortalResponse>(
      apiUrl,
      appleSessionId,
      findDevelopmentProfilesRequest({ bundleID: '', teamID: teamID ?? '' }),
      token,
    ),
  ]);
  assertApplePortalResponseOK(certificates.body, 'Apple Developer certificate list');
  assertApplePortalResponseOK(profiles.body, 'Apple Developer profile list');
  const summary = {
    certificateCount: certificates.body?.certRequests?.length ?? 0,
    profileCount: profiles.body?.provisioningProfiles?.length ?? 0,
  };
  setApplePortalSummary(summary);
  log(
    'Apple Developer resources fetched',
    `${summary.certificateCount} certificates, ${summary.profileCount} provisioning profiles`,
  );
}

async function refreshAppleDevices({
  apiUrl,
  token,
  appleSessionId,
  teamID,
  connectedUDID,
  setAppleDevices,
  setSelectedAppleDeviceIDs,
  log,
}: {
  apiUrl: string;
  token?: string;
  appleSessionId: string;
  teamID: string;
  connectedUDID?: string;
  setAppleDevices: (devices: AppleDeveloperPortalDevice[]) => void;
  setSelectedAppleDeviceIDs: (deviceIDs: string[]) => void;
  log: (message: string, detail?: string) => void;
}) {
  const response = await proxyProvisioningRequest<AppleDeveloperPortalResponse>(
    apiUrl,
    appleSessionId,
    findDeviceRequest({ deviceUDID: connectedUDID ?? '', teamID }),
    token,
  );
  assertApplePortalResponseOK(response.body, 'Apple device list');
  const devices = response.body?.devices ?? [];
  setAppleDevices(devices);
  const firstDeviceID = devices.find((device) => !!device.deviceId)?.deviceId;
  if (!connectedUDID) {
    setSelectedAppleDeviceIDs(firstDeviceID ? [firstDeviceID] : []);
    log('Apple Developer devices fetched', `${devices.length} devices`);
    return;
  }
  const connected = devices.find((device) => normalizeAppleUDID(device.deviceNumber) === normalizeAppleUDID(connectedUDID));
  if (connected?.deviceId) {
    setSelectedAppleDeviceIDs([connected.deviceId]);
    log('Connected iPhone found in Apple Developer devices', connected.name ?? connected.deviceNumber);
  } else {
    setSelectedAppleDeviceIDs(firstDeviceID ? [firstDeviceID] : []);
    log('Connected iPhone is not registered with Apple Developer', connectedUDID);
  }
}

async function prepareAppleSigningAssetsForDevice({
  apiUrl,
  token,
  appleSessionId,
  teamID,
  bundleID,
  deviceUDID,
  certificatePassword,
  deviceIDs,
  reusableCertificate,
}: {
  apiUrl: string;
  token?: string;
  appleSessionId: string;
  teamID: string;
  bundleID: string;
  deviceUDID?: string;
  deviceIDs: string[];
  certificatePassword?: string;
  reusableCertificate?: ReusableAppleCertificate;
}) {
  const normalizedUDID = deviceUDID?.replace(/-/g, '').replace(/[^a-fA-F0-9]/g, '') ?? '';
  const appIDID = await findOrCreateAppleBundleID({
    apiUrl,
    token,
    appleSessionId,
    teamID,
    bundleID,
  });

  let certificateID = reusableCertificate?.certificateID;
  let certificateP12Base64 = reusableCertificate?.certificateP12Base64;
  let storedCertificatePassword = reusableCertificate?.certificatePassword;
  if (!certificateID || !certificateP12Base64 || !storedCertificatePassword) {
    if (!certificatePassword) {
      throw new Error('Enter a .p12 password before preparing signing assets.');
    }
    const keyMaterial = await generateAppleSigningKeyAndCSR({
      commonName: `Limrun ${bundleID}`,
    });
    const certificateResponse = await proxyProvisioningRequest<AppleDeveloperPortalResponse>(
      apiUrl,
      appleSessionId,
      submitDevelopmentCSRRequest({ csrPEM: keyMaterial.csrPEM, teamID }),
      token,
    );
    assertApplePortalResponseOK(certificateResponse.body, 'Apple Development certificate creation');
    certificateID =
      stringField(certificateResponse.body?.certRequest, 'certificateId') ??
      stringField(certificateResponse.body?.certRequest, 'certRequestId') ??
      stringField(certificateResponse.body, 'certificateId') ??
      stringField(certificateResponse.body, 'certRequestId');
    if (!certificateID) {
      throw new Error('Apple certificate creation did not return a certificate ID.');
    }

    const downloadedCertificate = await proxyProvisioningRequest(
      apiUrl,
      appleSessionId,
      downloadCertificateRequest(certificateID, teamID),
      token,
    );
    if (downloadedCertificate.status < 200 || downloadedCertificate.status >= 300 || !downloadedCertificate.rawBodyBase64) {
      throw new Error(`Apple certificate download failed: HTTP ${downloadedCertificate.status}`);
    }
    certificateP12Base64 = exportAppleCertificateP12({
      privateKeyPKCS8Base64: keyMaterial.privateKeyPKCS8Base64,
      certificateBase64: downloadedCertificate.rawBodyBase64,
      password: certificatePassword,
      friendlyName: `Apple Development ${bundleID}`,
    });
    storedCertificatePassword = certificatePassword;
  }

  const profileName = `Limrun ${bundleID}`;
  const profileResponse = await proxyProvisioningRequest<AppleDeveloperPortalResponse>(
    apiUrl,
    appleSessionId,
    createDevelopmentProfileRequest({
      bundleID,
      teamID,
      appIDID,
      certificateID,
      deviceIDs,
      name: profileName,
    }),
    token,
  );
  assertApplePortalResponseOK(profileResponse.body, 'Apple provisioning profile creation');
  const profileID =
    stringField(profileResponse.body?.provisioningProfile, 'provisioningProfileId') ??
    stringField(profileResponse.body, 'provisioningProfileId');
  if (!profileID) {
    throw new Error('Apple provisioning profile creation did not return a profile ID.');
  }

  const downloadedProfile = await proxyProvisioningRequest(
    apiUrl,
    appleSessionId,
    downloadProfileRequest(profileID, teamID),
    token,
  );
  if (downloadedProfile.status < 200 || downloadedProfile.status >= 300 || !downloadedProfile.rawBodyBase64) {
    throw new Error(`Apple provisioning profile download failed: HTTP ${downloadedProfile.status}`);
  }
  const provisioningProfileBase64 = downloadedProfile.rawBodyBase64;
  const profile = parseProvisioningProfileBase64(provisioningProfileBase64);

  return putAppleGeneratedSigningAssets({
    bundleID,
    deviceUDID: normalizedUDID || undefined,
    teamID,
    certificateID,
    certificateP12Base64,
    certificatePassword: storedCertificatePassword,
    provisioningProfileBase64,
    profile,
  });
}

async function findOrCreateAppleBundleID({
  apiUrl,
  token,
  appleSessionId,
  teamID,
  bundleID,
}: {
  apiUrl: string;
  token?: string;
  appleSessionId: string;
  teamID: string;
  bundleID: string;
}) {
  const existing = await proxyProvisioningRequest<AppleDeveloperPortalResponse>(
    apiUrl,
    appleSessionId,
    findBundleIDRequest({ bundleID, teamID }),
    token,
  );
  assertApplePortalResponseOK(existing.body, 'Apple bundle ID lookup');
  const found = existing.body?.appIds?.find((app) => stringField(app, 'identifier') === bundleID || stringField(app, 'bundleId') === bundleID);
  const foundID = stringField(found, 'appIdId') ?? stringField(found, 'appId');
  if (foundID) return foundID;

  const created = await proxyProvisioningRequest<AppleDeveloperPortalResponse>(
    apiUrl,
    appleSessionId,
    createBundleIDRequest({ bundleID, teamID, name: bundleID }),
    token,
  );
  assertApplePortalResponseOK(created.body, 'Apple bundle ID creation');
  const createdID =
    stringField(created.body?.appId, 'appIdId') ??
    stringField(created.body?.appId, 'appId') ??
    stringField(created.body, 'appIdId') ??
    stringField(created.body, 'appId');
  if (!createdID) {
    throw new Error('Apple bundle ID creation did not return an App ID.');
  }
  return createdID;
}

function assertApplePortalResponseOK(response: AppleDeveloperPortalResponse | undefined, label: string) {
  if (!response) {
    throw new Error(`${label} returned an empty response.`);
  }
  if (response.resultCode !== undefined && response.resultCode !== 0) {
    throw new Error(`${label} failed: ${response.userString ?? response.resultString ?? response.resultCode}`);
  }
}

function stringField(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function normalizeAppleUDID(udid?: string) {
  return (udid ?? '').replace(/-/g, '').replace(/[^a-fA-F0-9]/g, '').toUpperCase();
}

function appleTeamSelectionID(team?: AppleDeveloperPortalTeam) {
  const value = team?.teamId ?? team?.providerId ?? team?.publicProviderId;
  return value === undefined || value === '' ? undefined : String(value);
}

function developerPortalTeamID(team?: AppleDeveloperPortalTeam) {
  return team?.teamId && team.teamId !== '' ? team.teamId : undefined;
}

function bundleIDFromAppleAppID(appID?: AppleDeveloperPortalAppID) {
  return appID?.identifier || appID?.bundleId || undefined;
}

async function fileToBase64(file: File) {
  const buffer = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
