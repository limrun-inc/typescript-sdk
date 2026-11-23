import { CONTROL_MSG_TYPE } from './constants';

/** A trace belongs to one connection; older servers keep the ordinary input format. */
export function createLatencyTrace(
  peer: RTCPeerConnection,
  onMessage: (message: Record<string, unknown>) => void,
) {
  const channel = peer.createDataChannel('latency-trace-v1', {
    ordered: true,
    negotiated: true,
    id: 2,
  });
  let accepted = false;
  let closed = false;
  let sequence = 0;
  channel.onmessage = (event) => {
    if (closed) return;
    let message: unknown;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      console.warn('Invalid latency trace message', error);
      return;
    }
    if (message && typeof message === 'object' && !Array.isArray(message)) {
      onMessage(message as Record<string, unknown>);
    }
  };
  channel.onclose = () => {
    closed = true;
    accepted = false;
  };
  return {
    accept(version: unknown) {
      accepted = !closed && version === 1;
    },
    wrap(data: ArrayBuffer): ArrayBuffer {
      if (!accepted || data.byteLength === 0) return data;
      const original = new DataView(data);
      const type = original.getUint8(0);
      // macOS pointer, key and scroll messages are traced whole; only macOS
      // daemons receive them, and they decode the envelope for every type.
      const macInput =
        type === CONTROL_MSG_TYPE.INJECT_MOUSE_EVENT ||
        type === CONTROL_MSG_TYPE.INJECT_MAC_KEY ||
        type === CONTROL_MSG_TYPE.INJECT_MAC_SCROLL;
      // v1 traces down/move/up. Keep cancel and Android pointer transitions usable.
      const touch =
        data.byteLength === 32 && type === CONTROL_MSG_TYPE.INJECT_TOUCH_EVENT && original.getUint8(1) <= 2;
      if (!macInput && !touch) return data;
      const envelope = new ArrayBuffer(6 + data.byteLength);
      const view = new DataView(envelope);
      view.setUint8(0, 240);
      view.setUint8(1, 1);
      view.setUint32(2, ++sequence, true);
      new Uint8Array(envelope, 6).set(new Uint8Array(data));
      return envelope;
    },
    close() {
      closed = true;
      accepted = false;
      channel.onmessage = null;
      channel.onclose = null;
      channel.close();
    },
  };
}
