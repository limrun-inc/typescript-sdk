import { useCallback, useEffect, useRef, useState } from 'react';
import {
  closeDeviceRelayTarget,
  getPairRecord,
  pairDevice,
  putPairRecord,
  requestUSBAccess,
  startDeviceInstall,
  type DeviceInstallLog,
  type DeviceRelayTarget,
  type InstallSource,
  type RelayClient,
  type StoredPairRecord,
} from './index';

export type DeviceInstallRelayBusyAction = 'usb' | 'pair' | 'install';

export type UseDeviceInstallRelayOptions = {
  apiUrl?: string;
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
  apiUrl,
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
    if (!apiUrl || !device) {
      throw new Error('Select a USB device before pairing.');
    }
    setBusyAction('pair');
    setError(undefined);
    setPairConfirmationRequired(false);
    try {
      await cleanupDeviceAccess();
      const result = await pairDevice({
        registryApiUrl: apiUrl,
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
  }, [apiUrl, cleanupDeviceAccess, device, organizationId, token]);

  const startInstallation = useCallback(
    async (installSource: InstallSource) => {
      if (!apiUrl || !device || !pairRecord) {
        throw new Error('Select and pair a USB device before starting installation.');
      }
      setBusyAction('install');
      setError(undefined);
      try {
        await cleanupDeviceAccess();
        relayRef.current = await startDeviceInstall({
          registryApiUrl: apiUrl,
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
    [apiUrl, cleanupDeviceAccess, device, organizationId, pairRecord, token],
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
    canPair: !!apiUrl && !busyAction && !!device,
    canInstall: !!apiUrl && !busyAction && !!device && !!pairRecord,
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
