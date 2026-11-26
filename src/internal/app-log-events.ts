import { nodeProxyTransport } from './proxy-transport';
import { directInstanceErrorReason } from './direct-instance-errors';

/** Where an instance serves an app's log as server-sent events, one event per line. */
export interface AppLogEventsSource {
  apiUrl: string;
  token: string;
  bundleId: string;
}

/**
 * followAppLogEvents reads `GET <apiUrl>/app-logs/stream?bundleId=` and calls `onLine` per event.
 * It resolves when the stream ends or `signal` aborts, and rejects on a non-2xx response or a
 * broken connection. The instance sends no ids and replays nothing, so nothing resumes.
 */
export async function followAppLogEvents(
  source: AppLogEventsSource,
  onLine: (line: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const url = `${source.apiUrl.replace(/\/+$/, '')}/app-logs/stream?${new URLSearchParams({
    bundleId: source.bundleId,
  })}`;
  const response = await nodeProxyTransport.fetch(url, {
    headers: { Authorization: `Bearer ${source.token}`, Accept: 'text/event-stream' },
    signal,
  });
  if (!response.ok || !response.body) {
    const reason = directInstanceErrorReason(await response.text());
    throw new Error(`GET /app-logs/stream failed: ${response.status} ${reason}`.trim());
  }
  for await (const event of readServerSentEvents(response.body)) onLine(event.data);
}

/**
 * readServerSentEvents yields the events of a server-sent event stream as they arrive. The data
 * fields of one event are joined with newlines; comments such as keepalives are skipped.
 */
export async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let data: string[] = [];
  let hasData = false;
  const reader = body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line === '') {
          if (hasData) yield { event, data: data.join('\n') };
          event = 'message';
          data = [];
          hasData = false;
        } else if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
          hasData = true;
        } else if (line === 'data') {
          data.push('');
          hasData = true;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
