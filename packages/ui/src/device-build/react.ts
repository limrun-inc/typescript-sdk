import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getIOSOTAInstall,
  startSignedDeviceBuild,
  watchBuildLogEvents,
  type BuildLogLine,
  type DeviceInstallBuildStatus,
  type IOSOTAInstall,
  type StoredSigningAssets,
} from './index';

export type UseDeviceBuildOptions = {
  apiUrl?: string;
  token?: string;
  signingAssets?: StoredSigningAssets;
  loadOTAInstall?: boolean;
};

export type StartDeviceBuildInput = {
  signingAssets?: StoredSigningAssets;
};

export type UseDeviceBuildResult = {
  status: DeviceInstallBuildStatus;
  logs: BuildLogLine[];
  execId?: string;
  otaInstall?: IOSOTAInstall;
  error?: string;
  startBuild: (input?: StartDeviceBuildInput) => Promise<string | undefined>;
  reset: () => void;
};

export function useDeviceBuild({
  apiUrl,
  token,
  signingAssets,
  loadOTAInstall = false,
}: UseDeviceBuildOptions): UseDeviceBuildResult {
  const [status, setStatus] = useState<DeviceInstallBuildStatus>('idle');
  const [logs, setLogs] = useState<BuildLogLine[]>([]);
  const [execId, setExecId] = useState<string | undefined>();
  const [otaInstall, setOTAInstall] = useState<IOSOTAInstall | undefined>();
  const [error, setError] = useState<string | undefined>();
  const stopWatcherRef = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    return () => {
      stopWatcherRef.current?.();
      stopWatcherRef.current = undefined;
    };
  }, []);

  const reset = useCallback(() => {
    stopWatcherRef.current?.();
    stopWatcherRef.current = undefined;
    setStatus('idle');
    setLogs([]);
    setExecId(undefined);
    setOTAInstall(undefined);
    setError(undefined);
  }, []);

  const startBuild = useCallback(
    async (input: StartDeviceBuildInput = {}) => {
      if (!apiUrl) {
        throw new Error('apiUrl is required to start a device build.');
      }
      const activeSigningAssets = input.signingAssets ?? signingAssets;
      if (!activeSigningAssets) {
        throw new Error('Signing assets are required to start a device build.');
      }
      stopWatcherRef.current?.();
      setStatus('queued');
      setLogs([]);
      setExecId(undefined);
      setOTAInstall(undefined);
      setError(undefined);
      try {
        const result = await startSignedDeviceBuild({
          limbuildApiUrl: apiUrl,
          token,
          certificateP12Base64: activeSigningAssets.certificateP12Base64,
          certificatePassword: activeSigningAssets.certificatePassword,
          provisioningProfileBase64: activeSigningAssets.provisioningProfileBase64,
        });
        if (!result.execId) {
          throw new Error('Build request did not return an exec ID.');
        }
        setExecId(result.execId);
        stopWatcherRef.current = watchBuildLogEvents({
          limbuildApiUrl: apiUrl,
          token,
          execId: result.execId,
          onLine: (line) => setLogs((current) => [...current, line]),
          onStatus: (nextStatus) => {
            setStatus(nextStatus);
            if (nextStatus === 'succeeded' && loadOTAInstall) {
              void getIOSOTAInstall({ limbuildApiUrl: apiUrl, token, execId: result.execId! })
                .then(setOTAInstall)
                .catch((caught) => setError(errorMessage(caught)));
            }
          },
          onError: (caught) => {
            setStatus('failed');
            setError(caught.message);
          },
        });
        return result.execId;
      } catch (caught) {
        setStatus('failed');
        setError(errorMessage(caught));
        return undefined;
      }
    },
    [apiUrl, loadOTAInstall, signingAssets, token],
  );

  return {
    status,
    logs,
    execId,
    otaInstall,
    error,
    startBuild,
    reset,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
