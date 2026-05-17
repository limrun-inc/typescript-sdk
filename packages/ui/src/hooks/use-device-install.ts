import { useCallback, useEffect, useRef, useState } from 'react';
import {
  closeDeviceRelayTarget,
  getPairRecord,
  getLatestSigningAssets,
  parseProvisioningProfile,
  profileContainsDevice,
  putPairRecord,
  putSigningAssets,
  requestUSBAccess as requestDeviceUSBAccess,
  startSignedDeviceBuild,
  startInstallRelay,
  startPairingRelay,
  watchBuildLogEvents,
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
  pairConfirmationRequired: boolean;
  logs: string[];
  buildLogs: BuildLogLine[];
  buildStatus: DeviceInstallBuildStatus;
  buildLogPanelOpen: boolean;
  busyAction?: DeviceInstallBusyAction;
  error?: string;
  canBuild: boolean;
  canRequestUSBAccess: boolean;
  canPairBrowser: boolean;
  canInstall: boolean;
  setSigningFiles: (files: DeviceInstallSigningFiles) => void;
  setBuildLogPanelOpen: (open: boolean) => void;
  startDeviceBuild: () => Promise<void>;
  requestUSBAccess: () => Promise<void>;
  pairBrowser: () => Promise<void>;
  startInstallation: () => Promise<void>;
  stopRelay: () => void;
};

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

const initialStepStatuses: DeviceInstallStepStatuses = {
  build: 'idle',
  usb: 'idle',
  pair: 'idle',
  install: 'idle',
};

export function useDeviceInstall({
  apiUrl,
  token,
}: UseDeviceInstallOptions): UseDeviceInstallResult {
  const [currentStep, setCurrentStep] = useState<DeviceInstallStep>('build');
  const [stepStatuses, setStepStatuses] = useState<DeviceInstallStepStatuses>(initialStepStatuses);
  const [selectedDevice, setSelectedDevice] = useState<DeviceRelayTarget | undefined>();
  const [pairRecord, setPairRecord] = useState<StoredPairRecord | undefined>();
  const [signingAssets, setSigningAssets] = useState<StoredSigningAssets | undefined>();
  const [logs, setLogs] = useState<string[]>([
    'Ready. Start a signed device build, allow USB access, pair this browser, then install.',
  ]);
  const [buildLogs, setBuildLogs] = useState<BuildLogLine[]>([]);
  const [buildStatus, setBuildStatus] = useState<DeviceInstallBuildStatus>('idle');
  const [buildLogPanelOpen, setBuildLogPanelOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<DeviceInstallBusyAction | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [pairConfirmationRequired, setPairConfirmationRequired] = useState(false);
  const [signingFiles, setSigningFilesState] = useState<DeviceInstallSigningFiles>({});
  const relayRef = useRef<RelayClient | undefined>(undefined);
  const selectedDeviceRef = useRef<DeviceRelayTarget | undefined>(undefined);
  const stopBuildWatcherRef = useRef<(() => void) | undefined>(undefined);

  const log = useCallback((message: string, detail?: string) => {
    const line = detail ? `${message}\n${detail}` : message;
    setLogs((current) => [line, ...current].slice(0, 100));
  }, []);

  const setStepStatus = useCallback((step: DeviceInstallStep, status: DeviceInstallStepStatus) => {
    setStepStatuses((current) => ({ ...current, [step]: status }));
  }, []);

  const setSigningFiles = useCallback((files: DeviceInstallSigningFiles) => {
    setSigningFilesState((current) => ({ ...current, ...files }));
    setSigningAssets(undefined);
  }, []);

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
      void cleanupDeviceAccess();
    };
  }, [cleanupDeviceAccess]);

  const resolveSigningAssetsForBuild = useCallback(async () => {
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
  }, [log, selectedDevice?.hello.serialNumber, signingFiles]);

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
            setCurrentStep('usb');
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
    setCurrentStep('usb');
    setStepStatus('usb', 'active');
    try {
      await cleanupDeviceAccess();
      const target = await requestDeviceUSBAccess({ log });
      setSelectedDevice(target);
      setPairConfirmationRequired(false);
      const storedPairRecord = await getPairRecord(target.hello.serialNumber);
      setPairRecord(storedPairRecord);
      const storedSigningAssets = await getLatestSigningAssets();
      if (storedSigningAssets) {
        if (!profileContainsDevice(storedSigningAssets.profile, target.hello.serialNumber)) {
          throw new Error('Stored provisioning profile does not include the selected iPhone.');
        }
        setSigningAssets(storedSigningAssets);
      }
      setStepStatus('usb', 'complete');
      setCurrentStep(storedPairRecord ? 'install' : 'pair');
      log(storedPairRecord ? 'Pair record found' : 'No pair record found', target.hello.serialNumber);
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      setStepStatus('usb', 'error');
      log('USB access failed', message);
    } finally {
      setBusyAction(undefined);
    }
  }, [cleanupDeviceAccess, log, setStepStatus]);

  const pairBrowser = useCallback(async () => {
    if (!apiUrl || !selectedDevice) return;
    setBusyAction('pair');
    setError(undefined);
    setPairConfirmationRequired(false);
    setCurrentStep('pair');
    setStepStatus('pair', 'active');
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
      setStepStatus('pair', 'complete');
      setCurrentStep('install');
      log('Device paired', 'The pair record was stored locally in this browser.');
    } catch (caught) {
      await closeDeviceRelayTarget(selectedDevice, log);
      const message = errorMessage(caught);
      setPairConfirmationRequired(true);
      setError('Unlock the iPhone, tap Trust, then confirm the pair record.');
      setStepStatus('pair', 'error');
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
    pairConfirmationRequired,
    logs,
    buildLogs,
    buildStatus,
    buildLogPanelOpen,
    busyAction,
    error,
    canBuild: !!apiUrl && !busyAction,
    canRequestUSBAccess: !busyAction && (buildStatus === 'succeeded' || stepStatuses.build === 'complete'),
    canPairBrowser: !!apiUrl && !busyAction && !!selectedDevice,
    canInstall: !!apiUrl && !busyAction && !!selectedDevice && !!pairRecord,
    setSigningFiles,
    setBuildLogPanelOpen,
    startDeviceBuild,
    requestUSBAccess,
    pairBrowser,
    startInstallation,
    stopRelay,
  };
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
