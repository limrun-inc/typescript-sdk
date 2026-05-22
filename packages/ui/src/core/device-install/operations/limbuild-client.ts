import type { BuildLogLine, DeviceInstallBuildStatus } from '../types';

export type LimbuildInfo = {
  homeDir?: string;
  lastBuildConfig?: {
    bundleId?: string;
    sdk?: string;
  };
};

export type StartSignedDeviceBuildOptions = {
  limbuildApiUrl: string;
  token?: string;
  certificateP12Base64: string;
  certificatePassword: string;
  provisioningProfileBase64: string;
};

export type BuildLogEventsOptions = {
  limbuildApiUrl: string;
  execId: string;
  token?: string;
  onLine: (line: BuildLogLine) => void;
  onStatus: (status: DeviceInstallBuildStatus) => void;
  onError?: (error: Error) => void;
};

export async function fetchLimbuildInfo(limbuildApiUrl: string, token?: string) {
  const url = new URL(`${limbuildApiUrl}/info`);
  if (token) {
    url.searchParams.set('token', token);
  }
  const response = await fetch(url.toString(), {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Info request failed: HTTP ${response.status} ${body}`);
  }
  return (await response.json()) as LimbuildInfo;
}

export async function startSignedDeviceBuild({
  limbuildApiUrl,
  token,
  certificateP12Base64,
  certificatePassword,
  provisioningProfileBase64,
}: StartSignedDeviceBuildOptions) {
  const url = new URL(`${limbuildApiUrl}/exec`);
  if (token) {
    url.searchParams.set('token', token);
  }
  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      command: 'xcodebuild',
      xcodebuild: { sdk: 'iphoneos' },
      signing: {
        certificateP12Base64,
        certificatePassword,
        provisioningProfileBase64,
      },
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Build request failed: HTTP ${response.status} ${body}`);
  }
  return (await response.json()) as { execId?: string };
}

export function watchBuildLogEvents({
  limbuildApiUrl,
  execId,
  token,
  onLine,
  onStatus,
  onError,
}: BuildLogEventsOptions) {
  const url = new URL(`${limbuildApiUrl}/exec/${execId}/events`);
  if (token) {
    url.searchParams.set('token', token);
  }
  const events = new EventSource(url.toString());
  onStatus('running');
  events.addEventListener('command', (event) => onLine({ type: 'command', data: event.data }));
  events.addEventListener('stdout', (event) => onLine({ type: 'stdout', data: event.data }));
  events.addEventListener('stderr', (event) => onLine({ type: 'stderr', data: event.data }));
  events.addEventListener('exitCode', (event) => {
    const code = parseInt(event.data, 10);
    onStatus(code === 0 ? 'succeeded' : code < 0 ? 'cancelled' : 'failed');
    events.close();
  });
  events.onerror = () => {
    events.close();
    onError?.(new Error('Build log stream closed before completion.'));
  };
  return () => events.close();
}
