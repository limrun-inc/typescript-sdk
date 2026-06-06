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
  type RelayClient,
  type StoredPairRecord,
} from './index';

export type DeviceInstallRelayBusyAction = 'usb' | 'pair' | 'install';

export type UseDeviceInstallRelayOptions = {
  apiUrl?: string;
  token?: string;
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
  startInstallation: () => Promise<RelayClient | undefined>;
  stopRelay: () => void;
  clearError: () => void;
};

export function useDeviceInstallRelay({
  apiUrl,
  token,
  log = noopLog,
}: UseDeviceInstallRelayOptions): UseDeviceInstallRelayResult {
  const [device, setDevice] = useState<DeviceRelayTarget | undefined>();
  const [pairRecord, setPairRecord] = useState<StoredPairRecord | undefined>();
  const [busyAction, setBusyAction] = useState<DeviceInstallRelayBusyAction | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [pairConfirmationRequired, setPairConfirmationRequired] = useState(false);
  const relayRef = useRef<RelayClient | undefined>(undefined);
  const deviceRef = useRef<DeviceRelayTarget | undefined>(undefined);

  const cleanupDeviceAccess = useCallback(async () => {
    relayRef.current?.close();
    relayRef.current = undefined;
    await closeDeviceRelayTarget(deviceRef.current, log);
  }, [log]);

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
      target = await requestUSBAccess({ log });
      const storedPairRecord = await getPairRecord(target.hello.serialNumber);
      setDevice(target);
      setPairRecord(storedPairRecord);
      log(storedPairRecord ? 'Pair record found' : 'No pair record found', target.hello.serialNumber);
      return target;
    } catch (caught) {
      await closeDeviceRelayTarget(target, log);
      setDevice(undefined);
      setPairRecord(undefined);
      setError(errorMessage(caught));
      return undefined;
    } finally {
      setBusyAction(undefined);
    }
  }, [cleanupDeviceAccess, log]);

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
        limbuildApiUrl: apiUrl,
        token,
        log,
        target: device,
      });
      const stored = await putPairRecord(result.pairRecord, {
        productName: device.hello.productName,
      });
      result.relay.close();
      await closeDeviceRelayTarget(device, log);
      setPairRecord(stored);
      setPairConfirmationRequired(false);
      log('Device paired', 'The pair record was stored locally in this browser.');
      return stored;
    } catch (caught) {
      await closeDeviceRelayTarget(device, log);
      setPairConfirmationRequired(true);
      setError(errorMessage(caught));
      return undefined;
    } finally {
      setBusyAction(undefined);
    }
  }, [apiUrl, cleanupDeviceAccess, device, log, token]);

  const startInstallation = useCallback(async () => {
    if (!apiUrl || !device || !pairRecord) {
      throw new Error('Select and pair a USB device before starting installation.');
    }
    setBusyAction('install');
    setError(undefined);
    try {
      await cleanupDeviceAccess();
      relayRef.current = await startDeviceInstall({
        limbuildApiUrl: apiUrl,
        token,
        log,
        target: device,
        pairRecord,
      });
      log('Device install started', 'Installation will continue through the connected iPhone.');
      return relayRef.current;
    } catch (caught) {
      await closeDeviceRelayTarget(device, log);
      setError(errorMessage(caught));
      return undefined;
    } finally {
      setBusyAction(undefined);
    }
  }, [apiUrl, cleanupDeviceAccess, device, log, pairRecord, token]);

  const stopRelay = useCallback(() => {
    void cleanupDeviceAccess();
    log('Device relay stopped');
  }, [cleanupDeviceAccess, log]);

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
