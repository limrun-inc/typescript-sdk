import PlaybackWorker from './video-playback.worker?worker&inline';

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
  let input: MediaStreamTrack | undefined;
  let output: MediaStreamTrack | undefined;
  let worker: Worker | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    input?.stop();
    output?.stop();
    if (worker) {
      worker.postMessage({ type: 'stop' });
      stopTimer = setTimeout(() => worker?.terminate(), 1000);
    }
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
      worker = new PlaybackWorker();
      worker.onmessage = ({ data }) => {
        if (data.type === 'error') fallback(new Error(data.message));
        else if (data.type === 'stopped') {
          clearTimeout(stopTimer);
          worker?.terminate();
        }
      };
      worker.onerror = (event) => fallback(new Error(event.message));
      worker.postMessage({ type: 'start', readable: processor.readable, writable: generator.writable }, [
        processor.readable,
        generator.writable,
      ]);
      play(new MediaStream(stream.getTracks().map((item) => (item === track ? generator : item))));
    } else {
      play(stream);
    }
  } catch (error) {
    fallback(error);
  }

  return stop;
}
