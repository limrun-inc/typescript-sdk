export {};

let abort: AbortController | undefined;
let completion: Promise<void> | undefined;

self.onmessage = async ({ data }) => {
  if (data.type === 'start') {
    abort = new AbortController();
    completion = (data.readable as ReadableStream<VideoFrame>)
      .pipeTo(data.writable, { signal: abort.signal })
      .catch((error: unknown) => {
        if (!abort?.signal.aborted) self.postMessage({ type: 'error', message: String(error) });
      });
  } else if (data.type === 'stop') {
    abort?.abort();
    await completion;
    self.postMessage({ type: 'stopped' });
    self.close();
  }
};
