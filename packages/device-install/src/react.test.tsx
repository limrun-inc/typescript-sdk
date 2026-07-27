import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useOTAInstall, type UseOTAInstallResult } from './react';

describe('useOTAInstall', () => {
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    if (renderer) {
      await act(async () => {
        renderer?.unmount();
      });
    }
    renderer = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('polls until a terminal state and then stops', async () => {
    let statusRequests = 0;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (init?.method === 'POST') {
        return Response.json(
          {
            id: 'session_1',
            installPageUrl: 'https://registry.example/ios/ota/install?session=signed',
            statusUrl: 'https://registry.example/ios/ota/status?session=signed',
            expiresAt: '2026-07-25T12:00:00Z',
          },
          { status: 201 },
        );
      }
      statusRequests += 1;
      return Response.json({
        id: 'session_1',
        state: statusRequests === 1 ? 'downloading' : 'downloaded',
        bytesTransferred: statusRequests === 1 ? 50 : 100,
        totalBytes: 100,
        progress: statusRequests === 1 ? 0.5 : 1,
        expiresAt: '2026-07-25T12:00:00Z',
      });
    });

    let hook: UseOTAInstallResult | undefined;
    function Harness() {
      hook = useOTAInstall({
        registryApiUrl: 'https://registry.example',
        token: 'scoped-token',
        pollIntervalMs: 1000,
      });
      return null;
    }
    await act(async () => {
      renderer = create(<Harness />);
    });
    await act(async () => {
      await hook!.start({
        assetId: 'asset_1',
        bundleIdentifier: 'com.example.app',
        shortVersion: '1.2.3',
        buildVersion: '42',
        title: 'Example',
      });
      await Promise.resolve();
    });
    expect(hook!.status?.state).toBe('downloading');
    expect(statusRequests).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(hook!.status?.state).toBe('downloaded');
    expect(statusRequests).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(statusRequests).toBe(2);
  });

  it('clears the previous QR before creating a replacement session', async () => {
    let failCreation = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (init?.method === 'POST') {
        if (failCreation) {
          return Response.json({ message: 'asset expired' }, { status: 410 });
        }
        return Response.json(
          {
            id: 'session_1',
            installPageUrl: 'https://registry.example/ios/ota/install?session=old',
            statusUrl: 'https://registry.example/ios/ota/status?session=old',
            expiresAt: '2026-07-25T12:00:00Z',
          },
          { status: 201 },
        );
      }
      return Response.json({
        id: 'session_1',
        state: 'downloaded',
        bytesTransferred: 100,
        totalBytes: 100,
        progress: 1,
        expiresAt: '2026-07-25T12:00:00Z',
      });
    });

    let hook: UseOTAInstallResult | undefined;
    function Harness() {
      hook = useOTAInstall({ registryApiUrl: 'https://registry.example', token: 'scoped-token' });
      return null;
    }
    await act(async () => {
      renderer = create(<Harness />);
    });
    const input = {
      assetId: 'asset_1',
      bundleIdentifier: 'com.example.app',
      shortVersion: '1.2.3',
      buildVersion: '42',
      title: 'Example',
    };
    await act(async () => {
      await hook!.start(input);
    });
    expect(hook!.session?.id).toBe('session_1');

    failCreation = true;
    await act(async () => {
      await hook!.start({ ...input, assetId: 'asset_2' });
    });
    expect(hook!.session).toBeUndefined();
    expect(hook!.error).toContain('asset expired');
  });
});

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
