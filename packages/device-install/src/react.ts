import { useCallback, useEffect, useRef, useState } from 'react';
import {
  closeDeviceRelayTarget,
  getPairRecord,
  getOTAInstallStatus,
  pairDevice,
  putPairRecord,
  requestUSBAccess,
  startDeviceInstall,
  createOTAInstallSession,
  type CreateOTAInstallSessionOptions,
  type DeviceInstallLog,
  type DeviceRelayTarget,
  type InstallSource,
  type OTAInstallSession,
  type OTAInstallStatus,
  type RelayClient,
  type StoredPairRecord,
} from './index';
import { errorMessage } from './internal/errors';

export type DeviceInstallRelayBusyAction = 'usb' | 'pair' | 'install';

export type UseDeviceInstallRelayOptions = {
  registryApiUrl?: string;
  token?: string;
  organizationId?: string;
  log?: DeviceInstallLog;
};

export type UseDeviceInstallRelayResult = {
  device?: DeviceRelayTarget;
  pairRecord?: StoredPairRecord;
  busyAction?: DeviceInstallRelayBusyAction;
  error?: string;
  pairConfirmationRequired: boolean;
  hasPairRecord: boolean;
  canPair: boolean;
  canInstall: boolean;
  requestUSBAccess: () => Promise<DeviceRelayTarget | undefined>;
  pairBrowser: () => Promise<StoredPairRecord | undefined>;
  startInstallation: (installSource: InstallSource) => Promise<RelayClient | undefined>;
  stopRelay: () => void;
  clearError: () => void;
};

export function useDeviceInstallRelay({
  registryApiUrl,
  token,
  organizationId,
  log = noopLog,
}: UseDeviceInstallRelayOptions): UseDeviceInstallRelayResult {
  const [device, setDevice] = useState<DeviceRelayTarget | undefined>();
  const [pairRecord, setPairRecord] = useState<StoredPairRecord | undefined>();
  const [busyAction, setBusyAction] = useState<DeviceInstallRelayBusyAction | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [pairConfirmationRequired, setPairConfirmationRequired] = useState(false);
  const relayRef = useRef<RelayClient | undefined>(undefined);
  const deviceRef = useRef<DeviceRelayTarget | undefined>(undefined);
  // Keep the logger in a ref so callbacks below don't change identity when the
  // consumer passes an unmemoized `log`. Otherwise every render would recreate
  // cleanupDeviceAccess, re-run the unmount effect, and close the USB device
  // mid-claim (surfacing as "Unable to claim interface" / "operation in progress").
  const logRef = useRef(log);
  logRef.current = log;

  const cleanupDeviceAccess = useCallback(async () => {
    relayRef.current?.close();
    relayRef.current = undefined;
    await closeDeviceRelayTarget(deviceRef.current, logRef.current);
  }, []);

  useEffect(() => {
    deviceRef.current = device;
  }, [device]);

  useEffect(() => {
    return () => {
      void cleanupDeviceAccess();
    };
  }, [cleanupDeviceAccess]);

  const selectUSBDevice = useCallback(async () => {
    setBusyAction('usb');
    setError(undefined);
    setPairConfirmationRequired(false);
    let target: DeviceRelayTarget | undefined;
    try {
      await cleanupDeviceAccess();
      target = await requestUSBAccess({ log: logRef.current });
      const storedPairRecord = await getPairRecord(target.hello.serialNumber);
      setDevice(target);
      setPairRecord(storedPairRecord);
      logRef.current(
        storedPairRecord ? 'Pair record found' : 'No pair record found',
        target.hello.serialNumber,
      );
      return target;
    } catch (caught) {
      await closeDeviceRelayTarget(target, logRef.current);
      setDevice(undefined);
      setPairRecord(undefined);
      setError(errorMessage(caught));
      return undefined;
    } finally {
      setBusyAction(undefined);
    }
  }, [cleanupDeviceAccess]);

  const pairBrowser = useCallback(async () => {
    if (!registryApiUrl || !device) {
      throw new Error('Select a USB device before pairing.');
    }
    setBusyAction('pair');
    setError(undefined);
    setPairConfirmationRequired(false);
    try {
      await cleanupDeviceAccess();
      const result = await pairDevice({
        registryApiUrl,
        token,
        organizationId,
        log: logRef.current,
        target: device,
      });
      const stored = await putPairRecord(result.pairRecord, {
        productName: device.hello.productName,
      });
      result.relay.close();
      await closeDeviceRelayTarget(device, logRef.current);
      setPairRecord(stored);
      setPairConfirmationRequired(false);
      logRef.current('Device paired', 'The pair record was stored locally in this browser.');
      return stored;
    } catch (caught) {
      await closeDeviceRelayTarget(device, logRef.current);
      setPairConfirmationRequired(true);
      setError(errorMessage(caught));
      return undefined;
    } finally {
      setBusyAction(undefined);
    }
  }, [registryApiUrl, cleanupDeviceAccess, device, organizationId, token]);

  const startInstallation = useCallback(
    async (installSource: InstallSource) => {
      if (!registryApiUrl || !device || !pairRecord) {
        throw new Error('Select and pair a USB device before starting installation.');
      }
      setBusyAction('install');
      setError(undefined);
      try {
        await cleanupDeviceAccess();
        relayRef.current = await startDeviceInstall({
          registryApiUrl,
          token,
          organizationId,
          log: logRef.current,
          target: device,
          pairRecord,
          installSource,
        });
        logRef.current('Device install started', 'Installation will continue through the connected iPhone.');
        return relayRef.current;
      } catch (caught) {
        await closeDeviceRelayTarget(device, logRef.current);
        setError(errorMessage(caught));
        return undefined;
      } finally {
        setBusyAction(undefined);
      }
    },
    [registryApiUrl, cleanupDeviceAccess, device, organizationId, pairRecord, token],
  );

  const stopRelay = useCallback(() => {
    void cleanupDeviceAccess();
    logRef.current('Device relay stopped');
  }, [cleanupDeviceAccess]);

  return {
    device,
    pairRecord,
    busyAction,
    error,
    pairConfirmationRequired,
    hasPairRecord: !!pairRecord,
    canPair: !!registryApiUrl && !busyAction && !!device,
    canInstall: !!registryApiUrl && !busyAction && !!device && !!pairRecord,
    requestUSBAccess: selectUSBDevice,
    pairBrowser,
    startInstallation,
    stopRelay,
    clearError: () => setError(undefined),
  };
}

function noopLog() {
  // Intentionally empty. Consumers can pass a logger for progress messages.
}

export type UseOTAInstallOptions = {
  registryApiUrl?: string;
  token?: string;
  organizationId?: string;
  pollIntervalMs?: number;
};

export type StartOTAInstallInput = Omit<
  CreateOTAInstallSessionOptions,
  'registryApiUrl' | 'token' | 'organizationId' | 'fetch' | 'signal'
>;

export type UseOTAInstallResult = {
  session?: OTAInstallSession;
  status?: OTAInstallStatus;
  busy: boolean;
  error?: string;
  start: (input: StartOTAInstallInput) => Promise<OTAInstallSession | undefined>;
  retry: () => void;
  reset: () => void;
};

export function useOTAInstall({
  registryApiUrl,
  token,
  organizationId,
  pollIntervalMs = 750,
}: UseOTAInstallOptions): UseOTAInstallResult {
  const [session, setSession] = useState<OTAInstallSession | undefined>();
  const [status, setStatus] = useState<OTAInstallStatus | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const generationRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const sessionRef = useRef<OTAInstallSession | undefined>(undefined);
  const pollRef = useRef<() => void>(() => {});

  const stopPolling = useCallback(() => {
    generationRef.current += 1;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = undefined;
    }
    abortRef.current?.abort();
    abortRef.current = undefined;
  }, []);

  pollRef.current = () => {
    const currentSession = sessionRef.current;
    if (!currentSession) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    void getOTAInstallStatus({
      statusUrl: currentSession.statusUrl,
      signal: controller.signal,
    })
      .then((nextStatus) => {
        if (generation !== generationRef.current) return;
        setStatus(nextStatus);
        setError(nextStatus.state === 'failed' ? nextStatus.error ?? 'The IPA download failed.' : undefined);
        if (!['downloaded', 'failed', 'expired'].includes(nextStatus.state)) {
          timeoutRef.current = setTimeout(() => pollRef.current(), pollIntervalMs);
        }
      })
      .catch((caught) => {
        if (generation !== generationRef.current || controller.signal.aborted) return;
        setError(errorMessage(caught));
        timeoutRef.current = setTimeout(() => pollRef.current(), pollIntervalMs);
      });
  };

  const start = useCallback(
    async (input: StartOTAInstallInput) => {
      if (!registryApiUrl || !token) {
        setError('A registry API URL and scoped token are required.');
        return undefined;
      }
      stopPolling();
      setBusy(true);
      setError(undefined);
      setStatus(undefined);
      sessionRef.current = undefined;
      setSession(undefined);
      const generation = generationRef.current;
      try {
        const created = await createOTAInstallSession({
          ...input,
          registryApiUrl,
          token,
          organizationId,
        });
        if (generation !== generationRef.current) return undefined;
        sessionRef.current = created;
        setSession(created);
        pollRef.current();
        return created;
      } catch (caught) {
        if (generation === generationRef.current) setError(errorMessage(caught));
        return undefined;
      } finally {
        if (generation === generationRef.current) setBusy(false);
      }
    },
    [organizationId, registryApiUrl, stopPolling, token],
  );

  const retry = useCallback(() => {
    if (!sessionRef.current) return;
    stopPolling();
    setError(undefined);
    pollRef.current();
  }, [stopPolling]);

  const reset = useCallback(() => {
    stopPolling();
    sessionRef.current = undefined;
    setSession(undefined);
    setStatus(undefined);
    setError(undefined);
    setBusy(false);
  }, [stopPolling]);

  useEffect(() => stopPolling, [stopPolling]);

  return { session, status, busy, error, start, retry, reset };
}
