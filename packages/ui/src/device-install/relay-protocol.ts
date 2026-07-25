export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_HEADER_BYTES = 16;

export const RelayMessageType = {
  DeviceHello: 1,
  OpenStream: 2,
  OpenResult: 3,
  StreamData: 4,
  StreamClose: 5,
  InstallProgress: 6,
  Error: 7,
  Ping: 8,
  Pong: 9,
  StartPairing: 10,
  StartInstall: 11,
  PairRecordReady: 12,
} as const;

export type RelayMessageType = (typeof RelayMessageType)[keyof typeof RelayMessageType];

export type RelayFrame = {
  type: RelayMessageType;
  requestId: number;
  streamId: number;
  payload: Uint8Array;
};

export function encodeFrame(frame: RelayFrame) {
  const result = new Uint8Array(RELAY_HEADER_BYTES + frame.payload.byteLength);
  const view = new DataView(result.buffer);
  view.setUint8(0, RELAY_PROTOCOL_VERSION);
  view.setUint8(1, frame.type);
  view.setUint8(2, 0);
  view.setUint8(3, 0);
  view.setUint32(4, frame.requestId);
  view.setUint32(8, frame.streamId);
  view.setUint32(12, frame.payload.byteLength);
  result.set(frame.payload, RELAY_HEADER_BYTES);
  return result;
}

export function decodeFrame(data: Uint8Array): RelayFrame {
  if (data.byteLength < RELAY_HEADER_BYTES) {
    throw new Error(`Relay frame too short: ${data.byteLength}`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = view.getUint8(0);
  if (version !== RELAY_PROTOCOL_VERSION) {
    throw new Error(`Unsupported relay protocol version ${version}`);
  }
  const payloadLength = view.getUint32(12);
  if (data.byteLength !== RELAY_HEADER_BYTES + payloadLength) {
    throw new Error(
      `Relay frame length mismatch: got ${data.byteLength}, expected ${RELAY_HEADER_BYTES + payloadLength}`,
    );
  }
  return {
    type: view.getUint8(1) as RelayMessageType,
    requestId: view.getUint32(4),
    streamId: view.getUint32(8),
    payload: data.slice(RELAY_HEADER_BYTES),
  };
}

export function encodeJson(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function decodeJson<T>(payload: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(payload)) as T;
}
