import type { DeviceHello, DeviceInstallLog, PairRecordPayload } from '../types';
import { decodeFrame, decodeJson, encodeFrame, encodeJson, RelayMessageType } from './relay-protocol';
import {
  openStream,
  receiveStreamData,
  sendStreamData,
  type UsbmuxSession,
  type UsbmuxStream,
} from './usbmux';

type OpenStreamPayload = {
  port: number;
};

type ProgressPayload = {
  message: string;
};

export class RelayClient {
  private socket?: WebSocket;
  private streams = new Map<number, UsbmuxStream>();
  private frameQueue = Promise.resolve();
  private closed = false;
  private pairRecordWaiter?: {
    resolve: (record: PairRecordPayload) => void;
    reject: (error: Error) => void;
  };

  constructor(
    private readonly webSocketUrl: string,
    private readonly session: UsbmuxSession,
    private readonly deviceHello: DeviceHello,
    private readonly log: DeviceInstallLog,
  ) {}

  async connect() {
    const socket = new WebSocket(this.webSocketUrl);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.onclose = () => {
      this.closed = true;
      this.log('Relay socket closed');
      // The server often sends PairRecordReady and then closes immediately. In
      // Chromium, onclose can be delivered before the queued onmessage handler
      // has finished processing that final frame. Drain the frame queue before
      // rejecting the waiter so a successful pair is not reported as
      // "Relay socket closed".
      void this.frameQueue.finally(() => {
        if (this.pairRecordWaiter) {
          this.pairRecordWaiter.reject(new Error('Relay socket closed'));
          this.pairRecordWaiter = undefined;
        }
      });
    };
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('WebSocket connection failed'));
    });
    socket.onmessage = (event) => {
      const data = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : new Uint8Array();
      this.enqueueFrame(data);
    };
    await this.send({
      type: RelayMessageType.DeviceHello,
      requestId: 0,
      streamId: 0,
      payload: encodeJson(this.deviceHello),
    });
    this.log('Connected WebSocket relay');
  }

  async startPairing() {
    const recordPromise = new Promise<PairRecordPayload>((resolve, reject) => {
      this.pairRecordWaiter = { resolve, reject };
    });
    await this.send({
      type: RelayMessageType.StartPairing,
      requestId: 0,
      streamId: 0,
      payload: encodeJson({}),
    });
    this.log('Pairing requested');
    return recordPromise;
  }

  async startInstall(pairRecord: PairRecordPayload) {
    await this.send({
      type: RelayMessageType.StartInstall,
      requestId: 0,
      streamId: 0,
      payload: encodeJson(pairRecord),
    });
    this.log('Installation requested');
  }

  close() {
    this.closed = true;
    this.socket?.close();
  }

  private enqueueFrame(data: Uint8Array) {
    this.frameQueue = this.frameQueue
      .then(() => this.handleFrame(decodeFrame(data)))
      .catch((error) => {
        this.log('Relay frame handling failed', error instanceof Error ? error.message : String(error));
      });
  }

  private async handleFrame(frame: ReturnType<typeof decodeFrame>) {
    switch (frame.type) {
      case RelayMessageType.OpenStream:
        await this.handleOpenStream(
          frame.requestId,
          frame.streamId,
          decodeJson<OpenStreamPayload>(frame.payload).port,
        );
        break;
      case RelayMessageType.StreamData: {
        const stream = this.streams.get(frame.streamId);
        if (!stream) throw new Error(`Unknown stream ${frame.streamId}`);
        await sendStreamData(stream, frame.payload);
        break;
      }
      case RelayMessageType.StreamClose:
        this.streams.delete(frame.streamId);
        break;
      case RelayMessageType.InstallProgress:
        this.log(formatInstallProgress(decodeJson<ProgressPayload>(frame.payload).message));
        break;
      case RelayMessageType.Error:
        this.handleError(frame.payload);
        break;
      case RelayMessageType.PairRecordReady:
        this.handlePairRecordReady(decodeJson<PairRecordPayload>(frame.payload));
        break;
      case RelayMessageType.Ping:
        await this.send({
          type: RelayMessageType.Pong,
          requestId: frame.requestId,
          streamId: 0,
          payload: new Uint8Array(),
        });
        break;
    }
  }

  private handleError(payload: Uint8Array) {
    const message = decodeServerError(payload);
    this.log('Server error', message);
    if (this.pairRecordWaiter) {
      this.pairRecordWaiter.reject(new Error(message));
      this.pairRecordWaiter = undefined;
    }
  }

  private handlePairRecordReady(record: PairRecordPayload) {
    this.log('Pair record received', record.udid);
    this.pairRecordWaiter?.resolve(record);
    this.pairRecordWaiter = undefined;
  }

  private async handleOpenStream(requestId: number, streamId: number, port: number) {
    try {
      const stream = await openStream(this.session, port);
      this.streams.set(streamId, stream);
      await this.send({
        type: RelayMessageType.OpenResult,
        requestId,
        streamId,
        payload: encodeJson({ ok: true }),
      });
      this.log(`Opened device stream ${streamId} to port ${port}`);
      void this.pumpDeviceToServer(streamId, stream);
    } catch (error) {
      this.log(
        `Open device stream ${streamId} failed`,
        error instanceof Error ? error.message : String(error),
      );
      await this.send({
        type: RelayMessageType.OpenResult,
        requestId,
        streamId,
        payload: encodeJson({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      });
    }
  }

  private async pumpDeviceToServer(streamId: number, stream: UsbmuxStream) {
    try {
      for (;;) {
        const data = await receiveStreamData(stream);
        if (this.closed) return;
        await this.send({
          type: RelayMessageType.StreamData,
          requestId: 0,
          streamId,
          payload: data,
        });
      }
    } catch (error) {
      this.log(`Device stream ${streamId} closed`, error instanceof Error ? error.message : String(error));
      await this.send({
        type: RelayMessageType.StreamClose,
        requestId: 0,
        streamId,
        payload: encodeJson({
          reason: error instanceof Error ? error.message : String(error),
        }),
      });
    }
  }

  private async send(frame: Parameters<typeof encodeFrame>[0]) {
    if (this.closed) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.closed = true;
      return;
    }
    this.socket.send(encodeFrame(frame));
  }
}

function decodeServerError(payload: Uint8Array) {
  const text = new TextDecoder().decode(payload);
  try {
    const parsed = JSON.parse(text) as { error?: string };
    return userFacingServerError(parsed.error ?? text);
  } catch {
    return userFacingServerError(text);
  }
}

function userFacingServerError(message: string) {
  return message.replace(/libimobiledevice/g, '').trim();
}

function formatInstallProgress(message: string) {
  const prefix = 'install status: ';
  if (!message.startsWith(prefix)) {
    return message;
  }
  const plist = message.slice(prefix.length);
  // The relay message is untrusted device input. Parsing it with DOMParser is
  // both an XSS DOM sink and an XML entity-expansion (billion-laughs) vector,
  // so extract only the cosmetic fields we render via plain string scanning
  // instead of building a DOM.
  const status = readPlistValue(plist, 'Status') ?? 'Unknown';
  const percent = readPlistValue(plist, 'PercentComplete');
  return `Install progress: ${percent ? `${percent}% ` : ''}${status}`;
}

// Returns the <string>/<integer>/<real> value immediately following
// <key>NAME</key> in an Apple plist fragment, without an XML/DOM parser.
function readPlistValue(plist: string, key: string): string | undefined {
  const pattern = new RegExp(
    `<key>\\s*${escapeRegExp(
      key,
    )}\\s*</key>\\s*<(?:string|integer|real)>([\\s\\S]*?)</(?:string|integer|real)>`,
  );
  const match = pattern.exec(plist);
  return match ? decodeBasicXmlEntities(match[1].trim()) : undefined;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeBasicXmlEntities(value: string) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
