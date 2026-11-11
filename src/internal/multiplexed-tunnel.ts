import type { Socket } from 'net';
import { WebSocket } from 'ws';

// Wire constants are shared with the Go and Swift implementations by contract fixtures.
export const MUX_VERSION_HEADER = 'x-limrun-mux-version';
export const MUX_WINDOW = 1024 * 1024;
export const MUX_MAX_WINDOW = 16 * MUX_WINDOW;
export const MUX_CHUNK = 64 * 1024;
export const MUX_MAX_CONNECTIONS = 64;
export const MuxOp = { open: 1, data: 2, window: 3, fin: 4, reset: 5 } as const;

export function muxFrame(op: number, id: number, payload?: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(5 + (payload?.length ?? 0));
  frame.writeUInt32BE(id, 0);
  frame[4] = op;
  if (payload) payload.copy(frame, 5);
  return frame;
}

type Flow = {
  id: number;
  socket: Socket;
  openPending: boolean;
  sendCredit: number;
  receiveCredit: number;
  receiveWindow: number;
  delivered: number;
  inputEnded: boolean;
  finSent: boolean;
  finReceived: boolean;
  reset: boolean;
};

/** One bounded, independently flow-controlled stream per local TCP connection. */
export class MultiplexedTunnel {
  private readonly flows = new Map<number, Flow>();
  private readonly ready = new Set<number>();
  private nextId = 1;
  private sending = false;
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly fail: (error: Error, protocolError: boolean) => void,
  ) {}

  attach(socket: Socket): void {
    // IDs are never reused within a WebSocket, so late frames cannot reach another socket.
    if (this.closed || this.flows.size >= MUX_MAX_CONNECTIONS || this.nextId > 0xffff_ffff) {
      socket.destroy();
      return;
    }
    const flow: Flow = {
      id: this.nextId++,
      socket,
      openPending: true,
      sendCredit: MUX_WINDOW,
      receiveCredit: MUX_WINDOW,
      receiveWindow: MUX_WINDOW,
      delivered: 0,
      inputEnded: false,
      finSent: false,
      finReceived: false,
      reset: false,
    };
    this.flows.set(flow.id, flow);
    socket.setNoDelay(true);
    // Pull only when there is credit; Node's readable high-water mark bounds unsent data.
    socket.on('readable', () => this.wake(flow));
    socket.on('end', () => {
      flow.inputEnded = true;
      this.wake(flow);
    });
    socket.on('error', () => this.reset(flow));
    socket.on('close', () => {
      if (flow.finSent && flow.finReceived) this.remove(flow);
      else this.reset(flow);
    });
    this.wake(flow);
  }

  receive(data: Buffer, binary: boolean): void {
    if (this.closed) return;
    if (!binary || data.length < 5 || data.length > MUX_CHUNK + 5) return this.invalid('invalid frame');
    const id = data.readUInt32BE(0),
      op = data[4],
      payload = data.subarray(5);
    if (!id || op! < MuxOp.open || op! > MuxOp.reset) {
      return this.invalid('invalid operation or connection ID');
    }
    if (
      (op === MuxOp.data && !payload.length) ||
      (op === MuxOp.window && payload.length !== 4) ||
      (op !== MuxOp.data && op !== MuxOp.window && payload.length !== 0)
    ) {
      return this.invalid('invalid payload length');
    }
    if (op === MuxOp.open) return this.invalid('server cannot open connections');
    const flow = this.flows.get(id);
    // Frames already in flight may arrive after a local reset.
    if (!flow || flow.reset) return;
    if (op === MuxOp.data) {
      if (flow.finReceived || payload.length > flow.receiveCredit)
        return this.invalid('receive window exceeded');
      flow.receiveCredit -= payload.length;
      flow.socket.write(payload, (error) => {
        if (error) {
          this.reset(flow);
          return;
        }
        if (this.flows.get(id) !== flow || flow.reset) return;
        flow.delivered += payload.length;
        if (flow.delivered >= flow.receiveWindow / 2) this.wake(flow);
      });
    } else if (op === MuxOp.window) {
      const increment = payload.readUInt32BE(0);
      if (!increment || increment > MUX_MAX_WINDOW || flow.sendCredit + increment > MUX_MAX_WINDOW) {
        return this.invalid('invalid window increment');
      }
      flow.sendCredit += increment;
      this.wake(flow);
    } else if (op === MuxOp.fin) {
      if (flow.finReceived) return this.invalid('duplicate FIN');
      flow.finReceived = true;
      // end() drains queued writes before sending TCP FIN; the other half stays open.
      flow.socket.end();
    } else if (op === MuxOp.reset) {
      this.remove(flow);
      flow.socket.destroy();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const flow of this.flows.values()) flow.socket.destroy();
    this.flows.clear();
    this.ready.clear();
  }

  private invalid(message: string): void {
    this.close();
    this.fail(new Error(`Multiplexed tunnel protocol error: ${message}`), true);
  }

  private remove(flow: Flow): void {
    if (this.flows.get(flow.id) !== flow) return;
    this.flows.delete(flow.id);
    this.ready.delete(flow.id);
  }

  private reset(flow: Flow): void {
    if (this.flows.get(flow.id) !== flow || this.closed) return;
    flow.reset = true;
    flow.socket.destroy();
    this.wake(flow);
  }

  private wake(flow: Flow): void {
    if (this.closed || this.flows.get(flow.id) !== flow) return;
    this.ready.add(flow.id);
    this.pump();
  }

  private frame(flow: Flow): Buffer | undefined {
    if (flow.reset) {
      this.remove(flow);
      return flow.openPending ? undefined : muxFrame(MuxOp.reset, flow.id);
    }
    if (flow.openPending) {
      flow.openPending = false;
      return muxFrame(MuxOp.open, flow.id);
    }
    if (flow.delivered >= flow.receiveWindow / 2) {
      const payload = Buffer.allocUnsafe(4);
      const growth = Math.min(flow.receiveWindow, MUX_MAX_WINDOW - flow.receiveWindow);
      flow.receiveWindow += growth;
      payload.writeUInt32BE(flow.delivered + growth);
      flow.receiveCredit += flow.delivered + growth;
      flow.delivered = 0;
      return muxFrame(MuxOp.window, flow.id, payload);
    }
    if (flow.sendCredit && flow.socket.readableLength) {
      const payload = flow.socket.read(
        Math.min(flow.sendCredit, flow.socket.readableLength, MUX_CHUNK),
      ) as Buffer | null;
      if (payload) {
        flow.sendCredit -= payload.length;
        return muxFrame(MuxOp.data, flow.id, payload);
      }
    }
    // Trigger end after consuming the last buffered bytes in paused/readable mode.
    if (!flow.socket.readableLength) flow.socket.read(0);
    if (flow.inputEnded && !flow.finSent) {
      flow.finSent = true;
      return muxFrame(MuxOp.fin, flow.id);
    }
    return undefined;
  }

  private pump(): void {
    if (this.sending || this.closed) return;
    for (const id of this.ready) {
      this.ready.delete(id);
      const flow = this.flows.get(id);
      if (!flow) continue;
      const frame = this.frame(flow);
      if (!frame) continue;
      // One frame per turn, and one WebSocket write in flight, bounds the shared
      // queue and prevents a bulk flow from getting ahead of ready small flows.
      if (this.flows.has(id)) this.ready.add(id);
      this.sending = true;
      this.ws.send(frame, { binary: true }, (error) => {
        this.sending = false;
        if (this.closed) return;
        if (error) {
          this.close();
          this.fail(error, false);
          return;
        }
        this.pump();
      });
      return;
    }
  }
}
