/** A trace belongs to one connection; older servers keep the ordinary input format. */
export function createTrace(peer: RTCPeerConnection, onMessage: (message: Record<string, unknown>) => void) {
  const channel = peer.createDataChannel('trace-v1', {
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
      console.warn('Invalid trace message', error);
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
      if (!accepted || data.byteLength !== 32 || new DataView(data).getUint8(0) !== 2) return data;
      const envelope = new ArrayBuffer(38);
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
