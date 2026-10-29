type VideoTrackAPIs = {
  MediaStreamTrackProcessor?: new (options: { track: MediaStreamTrack; maxBufferSize: number }) => {
    readable: ReadableStream<VideoFrame>;
  };
  MediaStreamTrackGenerator?: new (options: { kind: 'video' }) => MediaStreamTrack & {
    writable: WritableStream<VideoFrame>;
  };
};

export function attachVideoStream(
  video: HTMLVideoElement,
  stream: MediaStream,
  onError: (error: unknown) => void,
): () => void {
  const { MediaStreamTrackProcessor, MediaStreamTrackGenerator } = globalThis as VideoTrackAPIs;
  const track = stream.getVideoTracks()[0];
  const abort = new AbortController();
  let input: MediaStreamTrack | undefined;
  let output: MediaStreamTrack | undefined;
  let stopped = false;

  const stop = () => {
    stopped = true;
    abort.abort();
    input?.stop();
    output?.stop();
  };
  const play = (source: MediaStream) => {
    video.srcObject = source;
    void video.play().catch(() => undefined);
  };
  const fallback = (error: unknown) => {
    if (stopped) return;
    stop();
    onError(error);
    play(stream);
  };

  try {
    if (track && MediaStreamTrackProcessor && MediaStreamTrackGenerator) {
      // Forward decoded frames for responsive playback, keeping the receiver track intact.
      input = track.clone();
      const processor = new MediaStreamTrackProcessor({ track: input, maxBufferSize: 1 });
      const generator = new MediaStreamTrackGenerator({ kind: 'video' });
      output = generator;
      void processor.readable.pipeTo(generator.writable, { signal: abort.signal }).catch(fallback);
      play(new MediaStream(stream.getTracks().map((item) => (item === track ? generator : item))));
    } else {
      play(stream);
    }
  } catch (error) {
    fallback(error);
  }

  return stop;
}
