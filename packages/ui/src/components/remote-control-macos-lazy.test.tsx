import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteControl } from './remote-control';

vi.mock('../core/device-stream', () => ({
  createDeviceStream: vi.fn(() => ({
    attachVideo: vi.fn(),
    start: vi.fn(),
    dispose: vi.fn(),
    updateOptions: vi.fn(),
    bumpActivity: vi.fn(),
    pressButton: vi.fn(),
    getState: () => ({ connection: 'connected', controlReady: true, videoReady: true }),
    sendControl: vi.fn(),
  })),
}));

// The 3D MacBook, and three.js behind it, loads only when a viewer picks 3D, so it never holds up
// the 2D stream's first frame. This file stays apart so no other test has loaded it first.
const macbookFrame = vi.hoisted(() => ({ loaded: false }));
vi.mock('./macbook-frame', async (importOriginal) => {
  macbookFrame.loaded = true;
  return importOriginal();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('loads the 3D MacBook only when a viewer picks 3D', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1114);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(2000);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(<RemoteControl url="wss://example.com/v1/macos_eu_test/endpointWebSocket" token="t" />),
  );
  try {
    expect(host.querySelector('.rc-macbook')).not.toBeNull();
    expect(macbookFrame.loaded).toBe(false);
    const deep = host.querySelectorAll<HTMLButtonElement>('[aria-label="MacBook rendering"] button')[1]!;
    await act(async () => deep.click());
    await vi.waitFor(() => expect(macbookFrame.loaded).toBe(true));
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
