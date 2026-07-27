import { useCallback, useEffect, useState } from 'react';
import { useDeviceInstallRelay, useOTAInstall } from '@limrun/device-install/react';
import { errorMessage } from '../lib/apple';
import { fetchDeviceSession, type DeviceSession } from '../lib/backend';
import type { ConnectController } from './useConnect';
import type { InstallController } from './useInstall';

export type ActivityEntry = { at: string; message: string; detail?: string };
export type AutomaticInstallState = 'idle' | 'authorizing' | 'waiting' | 'installing' | 'started' | 'failed';
export type DeviceInstallController = ReturnType<typeof useDeviceInstall>;

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });

export function useDeviceInstall({
  connect,
  build,
  onError,
}: {
  connect: ConnectController;
  build: InstallController;
  onError: (message?: string) => void;
}) {
  const [session, setSession] = useState<DeviceSession>();
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [installState, setInstallState] = useState<AutomaticInstallState>('idle');
  const [authorizedInstallId, setAuthorizedInstallId] = useState<string>();
  const [authorizationAttempt, setAuthorizationAttempt] = useState(0);
  const [otaStartedInstallId, setOtaStartedInstallId] = useState<string>();

  const log = useCallback((message: string, detail?: string) => {
    setActivity((current) => [...current, { at: new Date().toLocaleTimeString(), message, detail }]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchDeviceSession()
      .then((fresh) => {
        if (!cancelled) {
          setSession(fresh);
          log('Device session ready', `expires at ${fresh.expiresAt}`);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) onError(errorMessage(caught, 'Could not start the device session'));
      });
    return () => {
      cancelled = true;
    };
  }, [log, onError]);

  const install = useDeviceInstallRelay({
    registryApiUrl: session?.registryUrl,
    token: session?.token,
    log,
  });
  const ota = useOTAInstall({
    registryApiUrl: session?.registryUrl,
    token: session?.token,
  });

  const prepareSelectedDevice = useCallback(
    async (profileKind: 'development' | 'adhoc') => {
      onError(undefined);
      const device = install.device;
      if (!device) {
        onError('Select an iPhone first.');
        return false;
      }
      if (profileKind === 'development' && !install.hasPairRecord) {
        onError('Pair the selected iPhone before preparing WebUSB signing.');
        return false;
      }
      if (!device.hello.serialNumber) {
        onError('The selected iPhone did not report a UDID.');
        return false;
      }
      return connect.prepareDevice(
        device.hello.serialNumber,
        device.hello.productName ?? 'iPhone',
        profileKind,
      );
    },
    [connect, install.device, install.hasPairRecord, onError],
  );

  // The successful webhook proves upload completion. Exchange only that
  // install ID for a token scoped to the exact uploaded asset.
  useEffect(() => {
    const installId = build.status?.id;
    if (build.state !== 'succeeded' || !installId || authorizedInstallId === installId) return;
    let cancelled = false;
    setInstallState('authorizing');
    void (async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          const fresh = await fetchDeviceSession(installId);
          if (cancelled) return;
          setSession(fresh);
          setAuthorizedInstallId(installId);
          setInstallState(build.method === 'webusb' ? 'waiting' : 'started');
          log('Exact-asset install session ready', fresh.assetName);
          return;
        } catch (caught) {
          lastError = caught;
          await pause(2000);
        }
      }
      if (!cancelled) {
        setInstallState('failed');
        onError(errorMessage(lastError, 'Could not authorize the built IPA'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authorizationAttempt, authorizedInstallId, build.method, build.state, build.status?.id, log, onError]);

  useEffect(() => {
    if (build.method !== 'webusb' || installState !== 'waiting' || !session?.assetId || !install.canInstall)
      return;
    setInstallState('installing');
    void install.startInstallation({ assetId: session.assetId }).then((relay) => {
      setInstallState(relay ? 'started' : 'failed');
    });
  }, [build.method, install, installState, session?.assetId]);

  useEffect(() => {
    const installId = build.status?.id;
    if (
      build.method !== 'qr' ||
      build.state !== 'succeeded' ||
      !installId ||
      authorizedInstallId !== installId ||
      otaStartedInstallId === installId ||
      !session?.assetId
    ) {
      return;
    }
    const webhook = build.status?.webhook;
    if (!webhook?.bundleIdentifier || !webhook.shortVersion || !webhook.buildVersion) {
      setOtaStartedInstallId(installId);
      onError('The build webhook did not include signed IPA metadata for an OTA manifest.');
      return;
    }
    setOtaStartedInstallId(installId);
    void ota.start({
      assetId: session.assetId,
      bundleIdentifier: webhook.bundleIdentifier,
      shortVersion: webhook.shortVersion,
      buildVersion: webhook.buildVersion,
      title: connect.connection?.appName || webhook.bundleIdentifier,
    });
  }, [
    authorizedInstallId,
    build.method,
    build.state,
    build.status,
    connect.connection?.appName,
    onError,
    ota,
    otaStartedInstallId,
    session?.assetId,
  ]);

  const retryInstallation = useCallback(() => {
    onError(undefined);
    install.clearError();
    if (session?.assetId) {
      setInstallState('waiting');
    } else {
      setAuthorizedInstallId(undefined);
      setAuthorizationAttempt((current) => current + 1);
    }
  }, [install, onError, session?.assetId]);

  const selectedUDID = install.device?.hello.serialNumber;
  const enrollmentReady = (profileKind: 'development' | 'adhoc') =>
    connect.deviceEnrollment.status === 'ready' &&
    connect.deviceEnrollment.profileKind === profileKind &&
    connect.deviceEnrollment.deviceUDID === selectedUDID?.replace(/[^a-fA-F0-9]/g, '').toUpperCase();

  return {
    install,
    ota,
    activity,
    installState,
    selectedUDID,
    enrollmentReady,
    prepareSelectedDevice,
    retryInstallation,
    retryOTA: () => setOtaStartedInstallId(undefined),
  };
}
