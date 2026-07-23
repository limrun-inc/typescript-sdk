import { useCallback, useMemo, useRef, useState } from 'react';
import { errorMessage } from './errors';
import {
  androidDeviceInfo,
  installApk,
  isWebUsbSupported,
  requestAndroidDevice,
  type AndroidApkSource,
  type AndroidDeviceInfo,
  type AndroidInstallLog,
  type AndroidInstallPhase,
  type AndroidInstallProgress,
  type AndroidUsbDevice,
} from './index';

export type UseAndroidApkInstallOptions = {
  log?: AndroidInstallLog;
  /**
   * Name shown next to this browser's key in the phone's
   * "Wireless debugging -> Paired devices" list. Defaults to "Limrun".
   */
  credentialStoreName?: string;
};

export type AndroidApkInstallStatus = 'idle' | AndroidInstallPhase | 'done' | 'error';

export type UseAndroidApkInstallResult = {
  /** False when the browser lacks WebUSB (Safari, Firefox, insecure context). */
  supported: boolean;
  device?: AndroidDeviceInfo;
  status: AndroidApkInstallStatus;
  busy: boolean;
  progress?: AndroidInstallProgress;
  error?: string;
  /** Open the WebUSB picker. Resolves to the device, or undefined on cancel. */
  requestDevice: () => Promise<AndroidDeviceInfo | undefined>;
  /** Install an APK onto the selected device. */
  install: (source: AndroidApkSource) => Promise<boolean>;
  /** Clears the outcome state; keeps the selected device. */
  reset: () => void;
};

export function useAndroidApkInstall({
  log,
  credentialStoreName,
}: UseAndroidApkInstallOptions = {}): UseAndroidApkInstallResult {
  const [device, setDevice] = useState<AndroidDeviceInfo | undefined>();
  const [status, setStatus] = useState<AndroidApkInstallStatus>('idle');
  const [progress, setProgress] = useState<AndroidInstallProgress | undefined>();
  const [error, setError] = useState<string | undefined>();
  const deviceRef = useRef<AndroidUsbDevice | undefined>(undefined);
  const busyRef = useRef(false);
  // Keep the logger in a ref so the callbacks below don't change identity
  // when the consumer passes an unmemoized `log`.
  const logRef = useRef(log);
  logRef.current = log;

  const requestDevice = useCallback(async () => {
    if (busyRef.current) {
      return undefined;
    }
    setError(undefined);
    try {
      const selected = await requestAndroidDevice();
      if (!selected) {
        return undefined;
      }
      deviceRef.current = selected;
      const info = androidDeviceInfo(selected);
      setDevice(info);
      setStatus('idle');
      setProgress(undefined);
      logRef.current?.('Device selected', `${info.name} (${info.serial})`);
      return info;
    } catch (caught) {
      setError(errorMessage(caught));
      return undefined;
    }
  }, []);

  const install = useCallback(
    async (source: AndroidApkSource) => {
      if (busyRef.current) {
        return false;
      }
      const target = deviceRef.current;
      if (!target) {
        setError('Select a USB device before installing.');
        setStatus('error');
        return false;
      }
      busyRef.current = true;
      setError(undefined);
      setProgress(undefined);
      try {
        await installApk({
          device: target,
          source,
          credentialStoreName,
          log: logRef.current,
          onPhase: setStatus,
          onProgress: setProgress,
        });
        setStatus('done');
        return true;
      } catch (caught) {
        setError(errorMessage(caught));
        setStatus('error');
        return false;
      } finally {
        busyRef.current = false;
      }
    },
    [credentialStoreName],
  );

  const reset = useCallback(() => {
    setStatus('idle');
    setError(undefined);
    setProgress(undefined);
  }, []);

  const busy = status === 'connecting' || status === 'authorizing' || status === 'installing';

  // Memoized so the result works as a prop or dependency without
  // re-rendering consumers on unrelated parent renders.
  return useMemo(
    () => ({
      supported: isWebUsbSupported(),
      device,
      status,
      busy,
      progress,
      error,
      requestDevice,
      install,
      reset,
    }),
    [device, status, busy, progress, error, requestDevice, install, reset],
  );
}
