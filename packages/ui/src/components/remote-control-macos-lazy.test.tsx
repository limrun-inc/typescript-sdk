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
// The download is held open until the test lets it finish, as a slow network would.
const macbookFrame = vi.hoisted(() => {
  let finish = () => {};
  const arrived = new Promise<void>((resolve) => (finish = resolve));
  return { loaded: false, arrived, finish: () => finish() };
});
vi.mock('./macbook-frame', async (importOriginal) => {
  macbookFrame.loaded = true;
  await macbookFrame.arrived;
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
    // While it downloads, the 3D button shows it is busy and the 2D MacBook stays.
    expect(deep.getAttribute('aria-busy')).toBe('true');
    expect(host.querySelector('.rc-macbook')).not.toBeNull();
    macbookFrame.finish();
    // jsdom has no WebGL, so the 3D MacBook appears with its error, and the button settles.
    await vi.waitFor(() => expect(deep.getAttribute('aria-busy')).toBe('false'));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('WebGL');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
