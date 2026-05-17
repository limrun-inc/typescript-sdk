/// <reference path="./webusb-dom.d.ts" />

import type { UsbmuxCandidate } from './webusb';
import { getBulkEndpoints, transferIn, transferOutWithZlp } from './webusb';

const PROTO_VERSION = 0;
const PROTO_SETUP = 2;
const PROTO_TCP = 6;
const MAGIC = 0xfeedface;
const FLAG_SYN = 0x02;
const FLAG_RST = 0x04;
const FLAG_ACK = 0x10;
const FIRST_SPORT = 49152;

export type UsbmuxSession = {
  device: USBDevice;
  candidate: UsbmuxCandidate;
  inEndpoint: ReturnType<typeof getBulkEndpoints>['inEndpoint'];
  outEndpoint: ReturnType<typeof getBulkEndpoints>['outEndpoint'];
  muxVersion: number;
  txSeq: number;
  rxSeq: number;
  nextSport: number;
  streams: Map<string, UsbmuxStream>;
  writeChain: Promise<void>;
  closed: boolean;
};

export type UsbmuxStream = {
  session: UsbmuxSession;
  sport: number;
  dport: number;
  seq: number;
  ack: number;
  queue: Uint8Array[];
  waiters: Array<(value: Uint8Array) => void>;
  error?: Error;
  opened: Promise<void>;
  resolveOpened: () => void;
  rejectOpened: (error: Error) => void;
};

export async function createUsbmuxSession(device: USBDevice, candidate: UsbmuxCandidate) {
  const { inEndpoint, outEndpoint } = getBulkEndpoints(candidate);
  const versionPayload = new Uint8Array(12);
  const versionView = new DataView(versionPayload.buffer);
  versionView.setUint32(0, 2);
  versionView.setUint32(4, 0);
  versionView.setUint32(8, 0);
  await transferOutWithZlp(device, outEndpoint, buildV1Packet(PROTO_VERSION, versionPayload));
  const versionPacket = await readPacket(device, inEndpoint, 1);
  const version = new DataView(versionPacket.payload.buffer, versionPacket.payload.byteOffset).getUint32(0);
  const session: UsbmuxSession = {
    device,
    candidate,
    inEndpoint,
    outEndpoint,
    muxVersion: version,
    txSeq: 0,
    rxSeq: 0xffff,
    nextSport: FIRST_SPORT,
    streams: new Map(),
    writeChain: Promise.resolve(),
    closed: false,
  };
  if (version >= 2) {
    await sendMux(session, PROTO_SETUP, new Uint8Array([0x07]));
  }
  void readLoop(session);
  return session;
}

export async function openStream(session: UsbmuxSession, port: number) {
  if (session.closed) {
    throw new Error('usbmux session is closed.');
  }
  let resolveOpened!: () => void;
  let rejectOpened!: (error: Error) => void;
  const stream: UsbmuxStream = {
    session,
    sport: session.nextSport++,
    dport: port,
    seq: 0,
    ack: 0,
    queue: [],
    waiters: [],
    opened: new Promise<void>((resolve, reject) => {
      resolveOpened = resolve;
      rejectOpened = reject;
    }),
    resolveOpened,
    rejectOpened,
  };
  session.streams.set(streamKey(port, stream.sport), stream);
  await sendTcp(stream, FLAG_SYN, new Uint8Array());
  await stream.opened;
  return stream;
}

export async function sendStreamData(stream: UsbmuxStream, bytes: Uint8Array) {
  if (stream.session.closed) {
    throw new Error('usbmux session is closed.');
  }
  await sendTcp(stream, FLAG_ACK, bytes);
  stream.seq += bytes.byteLength;
}

export async function receiveStreamData(stream: UsbmuxStream) {
  if (stream.queue.length > 0) {
    return stream.queue.shift()!;
  }
  if (stream.error) {
    throw stream.error;
  }
  return new Promise<Uint8Array>((resolve) => {
    stream.waiters.push(resolve);
  });
}

export function closeUsbmuxSession(session: UsbmuxSession) {
  session.closed = true;
  for (const stream of session.streams.values()) {
    stream.error = new Error('usbmux session closed');
    stream.rejectOpened(stream.error);
    while (stream.waiters.length > 0) {
      stream.waiters.shift()!(new Uint8Array());
    }
  }
  session.streams.clear();
}

async function sendTcp(stream: UsbmuxStream, flags: number, payload: Uint8Array) {
  const tcp = new Uint8Array(20 + payload.byteLength);
  const view = new DataView(tcp.buffer);
  view.setUint16(0, stream.sport);
  view.setUint16(2, stream.dport);
  view.setUint32(4, stream.seq);
  view.setUint32(8, stream.ack);
  view.setUint8(12, 0x50);
  view.setUint8(13, flags);
  view.setUint16(14, 512);
  tcp.set(payload, 20);
  await sendMux(stream.session, PROTO_TCP, tcp);
}

async function sendMux(session: UsbmuxSession, protocol: number, payload: Uint8Array) {
  if (session.closed) {
    throw new Error('usbmux session is closed.');
  }
  session.writeChain = session.writeChain.then(async () => {
    if (session.closed) return;
    const packet =
      session.muxVersion >= 2
        ? buildV2Packet(protocol, payload, session.txSeq++, session.rxSeq)
        : buildV1Packet(protocol, payload);
    await transferOutWithZlp(session.device, session.outEndpoint, packet);
  });
  return session.writeChain;
}

async function readLoop(session: UsbmuxSession) {
  try {
    for (;;) {
      if (session.closed) return;
      const packet = await readPacket(session.device, session.inEndpoint, session.muxVersion);
      if (session.closed) return;
      if (packet.rxSeq !== undefined) {
        session.rxSeq = packet.rxSeq;
      }
      if (packet.protocol !== PROTO_TCP) {
        continue;
      }
      const tcp = parseTcp(packet.payload);
      const stream = session.streams.get(streamKey(tcp.sport, tcp.dport));
      if (!stream) {
        continue;
      }
      if (tcp.flags & FLAG_RST) {
        stream.error = new Error(`Device reset stream ${stream.dport}`);
        stream.rejectOpened(stream.error);
        while (stream.waiters.length > 0) {
          stream.waiters.shift()!(new Uint8Array());
        }
        session.streams.delete(streamKey(stream.dport, stream.sport));
        continue;
      }
      if ((tcp.flags & (FLAG_SYN | FLAG_ACK)) === (FLAG_SYN | FLAG_ACK)) {
        stream.seq += 1;
        stream.ack = tcp.seq + 1;
        await sendTcp(stream, FLAG_ACK, new Uint8Array());
        stream.resolveOpened();
        continue;
      }
      if (tcp.payload.byteLength === 0) {
        continue;
      }
      stream.ack = tcp.seq + tcp.payload.byteLength;
      await sendTcp(stream, FLAG_ACK, new Uint8Array());
      if (stream.waiters.length > 0) {
        stream.waiters.shift()!(tcp.payload);
      } else {
        stream.queue.push(tcp.payload);
      }
    }
  } catch (error) {
    if (!session.closed) {
      closeUsbmuxSession(session);
    }
  }
}

async function readPacket(device: USBDevice, endpoint: UsbmuxSession['inEndpoint'], version: number) {
  for (;;) {
    const bytes = await transferIn(device, endpoint);
    const packet = parseMux(bytes, version);
    if (version === 1 && packet.protocol !== PROTO_VERSION) continue;
    return packet;
  }
}

function buildV1Packet(protocol: number, payload: Uint8Array) {
  const bytes = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, protocol);
  view.setUint32(4, bytes.byteLength);
  bytes.set(payload, 8);
  return bytes;
}

function buildV2Packet(protocol: number, payload: Uint8Array, txSeq: number, rxSeq: number) {
  const bytes = new Uint8Array(16 + payload.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, protocol);
  view.setUint32(4, bytes.byteLength);
  view.setUint32(8, MAGIC);
  view.setUint16(12, txSeq);
  view.setUint16(14, rxSeq);
  bytes.set(payload, 16);
  return bytes;
}

function parseMux(bytes: Uint8Array, version: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const protocol = view.getUint32(0);
  const length = view.getUint32(4);
  const headerSize = version >= 2 ? 16 : 8;
  return {
    protocol,
    length,
    rxSeq: version >= 2 ? view.getUint16(14) : undefined,
    payload: bytes.slice(headerSize, length),
  };
}

function parseTcp(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dataOffset = (view.getUint8(12) >> 4) * 4;
  return {
    sport: view.getUint16(0),
    dport: view.getUint16(2),
    seq: view.getUint32(4),
    ack: view.getUint32(8),
    flags: view.getUint8(13),
    payload: bytes.slice(dataOffset),
  };
}

function streamKey(devicePort: number, hostPort: number) {
  return `${devicePort}:${hostPort}`;
}
