import path from 'path';

/** Where a stopped speaker recording goes without `--output`: a timestamped WAV in the current directory. */
export function defaultSpeakerRecordingPath(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(process.cwd(), `speaker_${timestamp}.wav`);
}
