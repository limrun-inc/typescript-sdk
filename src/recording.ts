import path from 'path';
import fs from 'fs';
import { downloadFileToLocalPath } from './internal/download-file';

/** One MP4 part, ordered by its offset from the recording start. */
export interface RecordingSegment {
  downloadUrl: string;
  width: number;
  height: number;
  startTimeMs: number;
  durationMs: number;
  localPath?: string;
}

export interface RecordingSegmentMessage {
  path: string;
  width: number;
  height: number;
  startTimeMs: number;
  durationMs: number;
}

export async function downloadRecordingSegments(
  segments: RecordingSegmentMessage[] | undefined,
  downloadUrl: (file: string) => string,
  token: string,
  localDirectory?: string,
): Promise<RecordingSegment[]> {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error(
      'The instance did not return recording segments; update its runtime before using segmented recording',
    );
  }
  const result: RecordingSegment[] = [];
  for (const [index, segment] of segments.entries()) {
    if (
      !segment ||
      typeof segment.path !== 'string' ||
      !segment.path.endsWith('.mp4') ||
      !Number.isInteger(segment.width) ||
      segment.width <= 0 ||
      !Number.isInteger(segment.height) ||
      segment.height <= 0 ||
      !Number.isFinite(segment.startTimeMs) ||
      segment.startTimeMs < 0 ||
      !Number.isFinite(segment.durationMs) ||
      segment.durationMs < 0
    ) {
      throw new Error(`Invalid recording segment ${index}`);
    }
    const url = downloadUrl(segment.path);
    const localPath =
      localDirectory ? path.join(localDirectory, `segment-${String(index).padStart(6, '0')}.mp4`) : undefined;
    if (localPath) await downloadFileToLocalPath(url, token, localPath);
    result.push({
      downloadUrl: url,
      width: segment.width,
      height: segment.height,
      startTimeMs: segment.startTimeMs,
      durationMs: segment.durationMs,
      ...(localPath ? { localPath } : {}),
    });
  }
  if (localDirectory) {
    // Relative filenames keep the timeline usable after moving the downloaded directory.
    await fs.promises.writeFile(
      path.join(localDirectory, 'recording.json'),
      JSON.stringify(
        {
          segments: result.map(({ downloadUrl: _url, localPath, ...segment }) => ({
            ...segment,
            path: path.basename(localPath!),
          })),
        },
        null,
        2,
      ) + '\n',
    );
  }
  return result;
}
