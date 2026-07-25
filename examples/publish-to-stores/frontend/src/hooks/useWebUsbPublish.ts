import { useCallback, useEffect, useState } from 'react';
import { useDeviceInstallRelay } from '@limrun/device-install/react';
import { errorMessage } from '../lib/apple';
import { fetchDeviceSession, type DeviceSession } from '../lib/backend';
import type { ConnectController } from './useConnect';
import type { PublishController } from './usePublish';

export type WebUsbActivity = {
  at: string;
  message: string;
  detail?: string;
};

export type WebUsbInstallState = 'idle' | 'authorizing' | 'waiting' | 'installing' | 'started' | 'failed';

export type WebUsbController = ReturnType<typeof useWebUsbPublish>;

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });

export function useWebUsbPublish({
  connect,
  publish,
  onError,
}: {
  connect: ConnectController;
  publish: PublishController;
  onError: (message?: string) => void;
}) {
  const [session, setSession] = useState<DeviceSession>();
  const [activity, setActivity] = useState<WebUsbActivity[]>([]);
  const [installState, setInstallState] = useState<WebUsbInstallState>('idle');
  const [authorizedPublishId, setAuthorizedPublishId] = useState<string>();
  const [authorizationAttempt, setAuthorizationAttempt] = useState(0);

  const log = useCallback((message: string, detail?: string) => {
    setActivity((current) => [...current, { at: new Date().toLocaleTimeString(), message, detail }]);
  }, []);

  // Pairing never needs asset access. Fetch the least-privileged session as
  // soon as the wizard loads so the native USB picker is ready on user click.
  useEffect(() => {
    let cancelled = false;
    void fetchDeviceSession()
      .then((fresh) => {
        if (cancelled) return;
        setSession(fresh);
        log('Device pairing session ready', `expires at ${fresh.expiresAt}`);
      })
      .catch((caught: unknown) => {
        if (!cancelled) onError(errorMessage(caught, 'Could not start the WebUSB session'));
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

  const prepareSelectedDevice = useCallback(async () => {
    onError(undefined);
    const device = install.device;
    if (!device) {
      onError('Select an iPhone before preparing WebUSB signing.');
      return false;
    }
    if (!install.hasPairRecord) {
      onError('Pair the selected iPhone before preparing WebUSB signing.');
      return false;
    }
    if (!device.hello.serialNumber) {
      onError('The selected iPhone did not report a UDID.');
      return false;
    }
    return connect.prepareWebUsbDevice(device.hello.serialNumber, device.hello.productName ?? 'iPhone');
  }, [connect, install.device, install.hasPairRecord, onError]);

  // A successful webhook proves the private asset upload completed. Exchange
  // only that publish ID for a fresh device+asset token; retry briefly for
  // eventual consistency between the upload and asset listing.
  useEffect(() => {
    const publishId = publish.status?.id;
    if (
      publish.method !== 'webusb' ||
      publish.state !== 'succeeded' ||
      !publishId ||
      authorizedPublishId === publishId
    ) {
      return;
    }
    let cancelled = false;
    setInstallState('authorizing');
    void (async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          const fresh = await fetchDeviceSession(publishId);
          if (cancelled) return;
          setSession(fresh);
          setAuthorizedPublishId(publishId);
          setInstallState('waiting');
          log('Asset-specific install session ready', fresh.assetName);
          return;
        } catch (caught) {
          lastError = caught;
          await pause(2000);
        }
      }
      if (cancelled) return;
      setInstallState('failed');
      onError(errorMessage(lastError, 'Could not authorize the WebUSB install'));
    })();
    return () => {
      cancelled = true;
    };
  }, [
    authorizationAttempt,
    authorizedPublishId,
    log,
    onError,
    publish.method,
    publish.state,
    publish.status?.id,
  ]);

  // Re-rendering with the asset-scoped token rebuilds startInstallation with
  // that token while preserving the selected USB device and pair record.
  useEffect(() => {
    if (installState !== 'waiting' || !session?.assetId || !install.canInstall) return;
    setInstallState('installing');
    void install.startInstallation({ assetId: session.assetId }).then((relay) => {
      if (relay) {
        setInstallState('started');
      } else {
        setInstallState('failed');
      }
    });
  }, [install, installState, session?.assetId]);

  const retryInstallation = useCallback(() => {
    onError(undefined);
    install.clearError();
    if (session?.assetId) {
      setInstallState('waiting');
      return;
    }
    setAuthorizedPublishId(undefined);
    setAuthorizationAttempt((current) => current + 1);
  }, [install, onError, session?.assetId]);

  const selectedUDID = install.device?.hello.serialNumber;
  const enrollmentReady =
    connect.webUsbEnrollment.status === 'ready' &&
    connect.webUsbEnrollment.deviceUDID === selectedUDID?.replace(/[^a-fA-F0-9]/g, '').toUpperCase();

  return {
    install,
    activity,
    installState,
    selectedUDID,
    enrollmentReady,
    prepareSelectedDevice,
    retryInstallation,
  };
}
