import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

export type Message = Record<string, any>;

/** One socket per peer keeps Android's unlabelled answers isolated between viewers. */
export class Signaling {
  readonly sessionId = randomUUID();
  readonly ws: WebSocket;
  private listeners = new Set<(message: Message) => void>();
  private failures = new Set<(error: Error) => void>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(endpoint: string, token: string) {
    this.ws = new WebSocket(endpoint, {
      headers: { authorization: `Bearer ${token}` },
      maxPayload: 16 * 1024 * 1024,
    });
    this.ws.on('message', (data, binary) => {
      if (binary) return;
      try {
        const message = JSON.parse(data.toString());
        for (const fn of this.listeners) fn(message);
      } catch {
        /* Ignore non-protocol keepalive replies. */
      }
    });
    const fail = () => {
      this.closed = true;
      clearInterval(this.heartbeat);
      for (const fn of this.failures) fn(new Error('Simulator disconnected'));
    };
    this.ws.on('error', fail);
    this.ws.on('close', fail);
  }

  async open(): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.close();
          reject(new Error('Simulator connection timed out'));
        }, 10_000);
        const done = (error?: Error) => {
          clearTimeout(timer);
          this.ws.off('open', opened);
          this.ws.off('error', failed);
          this.ws.off('close', closed);
          error ? reject(error) : resolve();
        };
        const opened = () => done();
        const failed = () => done(new Error('Simulator connection failed'));
        const closed = () => done(new Error('Simulator disconnected'));
        this.ws.once('open', opened);
        this.ws.once('error', failed);
        this.ws.once('close', closed);
      });
    this.heartbeat = setInterval(() => this.send({ type: 'keepAlive', sessionId: this.sessionId }), 30_000);
    this.heartbeat.unref();
  }

  send(message: Message | Buffer): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(Buffer.isBuffer(message) ? message : JSON.stringify(message));
  }

  subscribe(fn: (message: Message) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  wait(predicate: (message: Message) => boolean): Promise<Message> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('Simulator disconnected'));
      const finish = (message?: Message, error?: Error) => {
        clearTimeout(timer);
        this.listeners.delete(receive);
        this.failures.delete(fail);
        error ? reject(error) : resolve(message!);
      };
      const fail = (error: Error) => finish(undefined, error);
      const receive = (message: Message) => {
        if (message['type'] === 'signalingError' || message['type'] === 'error')
          fail(new Error('Simulator refused the request'));
        else if (predicate(message))
          message['error'] ? fail(new Error(String(message['error']))) : finish(message);
      };
      const timer = setTimeout(() => fail(new Error('Simulator request timed out')), 15_000);
      this.listeners.add(receive);
      this.failures.add(fail);
    });
  }

  request(type: string, parameters: Message = {}): Promise<Message> {
    const id = randomUUID();
    const response = this.wait((message) => message['id'] === id);
    this.send({ type, id, ...parameters });
    return response;
  }

  async configuration(): Promise<Message> {
    const response = this.wait((message) => message['type'] === 'rtcConfiguration');
    this.send({ type: 'requestRtcConfiguration', sessionId: this.sessionId });
    const config = await response;
    if (config['compatibilityVersion'] !== 1)
      throw new Error('This simulator runtime needs serve-sim compatibility support');
    return config;
  }

  async offer(sdp: string, display: 'active' | 'outer' | 'inner'): Promise<string> {
    const candidates: Message[] = [];
    const unsubscribe = this.subscribe((message) => {
      if (message['type'] === 'candidate' && message['candidate']) candidates.push(message);
    });
    const answer = this.wait((message) => message['type'] === 'answer');
    const complete = this.wait((message) => message['type'] === 'candidate' && message['candidate'] === '');
    this.send({ type: 'offer', sessionId: this.sessionId, sdp, display, completeIce: true });
    try {
      const [result] = await Promise.all([answer, complete]);
      return gatherAnswer(result['sdp'], candidates);
    } finally {
      unsubscribe();
    }
  }

  close(): void {
    clearInterval(this.heartbeat);
    if (this.ws.readyState === WebSocket.CONNECTING) this.ws.terminate();
    else this.ws.close();
  }
}

/** serve-sim takes a complete SDP answer instead of trickled candidates. */
export function gatherAnswer(sdp: string, candidates: Message[]): string {
  const sections = sdp.split(/\r?\nm=/);
  for (let index = 1; index < sections.length; index++) {
    const mid = sections[index]!.match(/(?:^|\r?\n)a=mid:([^\r\n]+)/)?.[1];
    const matches = candidates.filter(
      (candidate) => candidate['sdpMid'] === mid || candidate['sdpMLineIndex'] === index - 1,
    );
    sections[index] =
      sections[index]!.trimEnd() +
      '\r\n' +
      matches.map((candidate) => `a=${candidate['candidate']}\r\n`).join('') +
      'a=end-of-candidates\r\n';
  }
  return sections.join('\r\nm=');
}
