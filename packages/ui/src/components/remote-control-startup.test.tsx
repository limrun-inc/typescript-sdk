import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteControl } from './remote-control';

vi.mock('./duo-view', () => ({
  default: () => <div data-testid="duo-frame" />,
}));

class SignalingSocket extends EventTarget {
  static OPEN = 1;
  static latest: SignalingSocket;
  readyState = 1;
  onopen?: () => void;
  onmessage?: (event: MessageEvent) => void;
  onclose?: () => void;
  sent: { type: string; id?: string }[] = [];
  constructor() {
    super();
    SignalingSocket.latest = this;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
  receive(message: object) {
    const event = new MessageEvent('message', { data: JSON.stringify(message) });
    this.dispatchEvent(event);
    this.onmessage?.(event);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([true, false])(
  'renders Duo before the control channel opens (explicit model: %s)',
  async (explicitModel) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('WebSocket', SignalingSocket);
    vi.stubGlobal('RTCRtpReceiver', {});
    vi.stubGlobal('RTCRtpSender', {});
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    const channel = { readyState: 'connecting', close: vi.fn(), onopen: undefined };
    vi.stubGlobal(
      'RTCPeerConnection',
      class {
        addTransceiver() {
          return { sender: {}, setCodecPreferences() {} };
        }
        createDataChannel() {
          return channel;
        }
        async createOffer() {
          return { type: 'offer', sdp: 'test' };
        }
        async setLocalDescription() {}
        close() {}
      },
    );
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          <RemoteControl
            url="wss://example.com/socket"
            token="test"
            assets={{ ios: { loadingLogo: '/apple.svg' } }}
            deviceModel={explicitModel ? 'iphone-duo' : undefined}
          />,
        ),
      );
      if (explicitModel) {
        expect(host.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe(
          'Connecting to iPhone Duo',
        );
        expect(host.querySelector('[role="status"] img')?.getAttribute('src')).toBe('/apple.svg');
        expect(host.querySelector('.rc-duo-flat-frame')).not.toBeNull();
        expect(host.querySelector('.rc-duo-view button')).toBeNull();
      }
      const socket = SignalingSocket.latest;
      await act(async () => socket.onopen?.());
      await act(async () =>
        socket.receive({
          type: 'rtcConfiguration',
          rtcConfiguration: {},
          foldSupported: true,
        }),
      );
      expect(channel.readyState).toBe('connecting');
      expect(socket.sent.map((message) => message.type)).toEqual([
        'requestRtcConfiguration',
        'getFoldState',
        'offer',
      ]);
      await act(async () =>
        socket.receive({
          type: 'foldStateResult',
          id: 'duo-capabilities',
          state: {
            angleDegrees: 0,
            minAngleDegrees: 0,
            maxAngleDegrees: 180,
            orientation: 'portrait',
            displays: [],
          },
        }),
      );
      await vi.waitFor(() => expect(host.querySelector('[data-testid="duo-frame"]')).not.toBeNull());
      expect(channel.readyState).toBe('connecting');
    } finally {
      await act(async () => root.unmount());
    }
  },
);
