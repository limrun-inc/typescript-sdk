// QR/OTA installation of the built IPA. After the build webhook proves the
// upload finished, the install ID is exchanged for a token scoped to exactly
// that asset; the user then explicitly creates the private OTA session whose
// install page URL becomes the QR code.
import { useCallback, useEffect, useState } from 'react';
import { useOTAInstall } from '@limrun/device-install/react';
import { errorMessage, fetchDeviceSession, sleep, type DeviceSession } from '../lib/backend';
import type { ConnectController } from './useConnect';
import type { InstallController } from './useInstall';

export type ActivityEntry = { at: string; message: string; detail?: string };
export type AuthorizationState = 'idle' | 'authorizing' | 'ready' | 'failed';
export type DeviceInstallController = ReturnType<typeof useDeviceInstall>;

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
  const [authorization, setAuthorization] = useState<AuthorizationState>('idle');
  const [authorizedInstallId, setAuthorizedInstallId] = useState<string>();
  const [authorizationAttempt, setAuthorizationAttempt] = useState(0);

  // The one memoized callback in this hook: log's identity feeds the
  // effects below, so a plain function would re-run them (and refetch the
  // session) on every render.
  const log = useCallback((message: string, detail?: string) => {
    setActivity((current) => [...current, { at: new Date().toLocaleTimeString(), message, detail }]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchDeviceSession()
      .then((fresh) => {
        if (!cancelled) {
          setSession(fresh);
          log('Install session ready', `expires at ${fresh.expiresAt}`);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) onError(errorMessage(caught, 'Could not start the install session'));
      });
    return () => {
      cancelled = true;
    };
  }, [log, onError]);

  const ota = useOTAInstall({
    registryApiUrl: session?.registryUrl,
    token: session?.token,
  });

  // The successful webhook proves upload completion. Exchange only that
  // install ID for a token scoped to the exact uploaded asset.
  useEffect(() => {
    const installId = build.status?.id;
    if (build.state !== 'succeeded' || !installId || authorizedInstallId === installId) return;
    let cancelled = false;
    setAuthorization('authorizing');
    void (async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          const fresh = await fetchDeviceSession(installId);
          if (cancelled) return;
          setSession(fresh);
          setAuthorizedInstallId(installId);
          setAuthorization('ready');
          log('Exact-asset install session ready', fresh.assetName);
          return;
        } catch (caught) {
          lastError = caught;
          await sleep(2000);
        }
      }
      if (!cancelled) {
        setAuthorization('failed');
        onError(errorMessage(lastError, 'Could not authorize the built IPA'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authorizationAttempt, authorizedInstallId, build.state, build.status?.id, log, onError]);

  /** Creates the private OTA session for the authorized build's asset. */
  function startQRInstall() {
    onError(undefined);
    const webhook = build.status?.webhook;
    if (authorization !== 'ready' || !session?.assetId) {
      onError('The built IPA is not authorized yet.');
      return;
    }
    if (!webhook?.bundleIdentifier || !webhook.shortVersion || !webhook.buildVersion) {
      onError('The build webhook did not include signed IPA metadata for an OTA manifest.');
      return;
    }
    log('Creating the private OTA install session');
    void ota
      .start({
        assetId: session.assetId,
        bundleIdentifier: webhook.bundleIdentifier,
        shortVersion: webhook.shortVersion,
        buildVersion: webhook.buildVersion,
        title: connect.connection?.appName || webhook.bundleIdentifier,
      })
      .then((created) => {
        if (created) log('OTA install page ready', created.installPageUrl);
      });
  }

  function retryAuthorization() {
    onError(undefined);
    setAuthorizedInstallId(undefined);
    setAuthorizationAttempt((current) => current + 1);
  }

  return {
    ota,
    activity,
    authorization,
    startQRInstall,
    retryAuthorization,
  };
}
