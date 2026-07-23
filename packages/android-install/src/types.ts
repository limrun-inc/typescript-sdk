export type AndroidInstallLog = (message: string, detail?: string) => void;

export type AndroidInstallPhase = 'connecting' | 'authorizing' | 'installing';

export type AndroidInstallProgress = {
  receivedBytes: number;
  totalBytes: number;
};

/**
 * Where the APK bytes come from. Signed download URLs from the Limrun assets
 * API work directly; any CORS-accessible URL does.
 */
export type AndroidApkSource =
  | { downloadUrl: string }
  | { file: File }
  | { stream: ReadableStream<Uint8Array>; size: number };

export type AndroidDeviceInfo = {
  serial: string;
  name: string;
};
