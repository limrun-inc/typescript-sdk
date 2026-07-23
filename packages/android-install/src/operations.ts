import { Adb, AdbDaemonTransport } from '@yume-chan/adb';
import AdbWebCredentialStore from '@yume-chan/adb-credential-web';
import { AdbDaemonWebUsbDevice, AdbDaemonWebUsbDeviceManager } from '@yume-chan/adb-daemon-webusb';
import { PackageManager } from '@yume-chan/android-bin';
import type {
  AndroidApkSource,
  AndroidDeviceInfo,
  AndroidInstallLog,
  AndroidInstallPhase,
  AndroidInstallProgress,
} from './types';

export type AndroidUsbDevice = AdbDaemonWebUsbDevice;

const DEFAULT_CREDENTIAL_STORE_NAME = 'Limrun';

// One key pair per browser so the phone's "always allow from this computer"
// checkbox keeps working across sessions. Created lazily: the constructor is
// harmless, but module evaluation must stay side-effect free for SSR.
let defaultCredentialStore: AdbWebCredentialStore | undefined;

function credentialStore(name?: string): AdbWebCredentialStore {
  if (name) {
    return new AdbWebCredentialStore(name);
  }
  defaultCredentialStore ??= new AdbWebCredentialStore(DEFAULT_CREDENTIAL_STORE_NAME);
  return defaultCredentialStore;
}

export function isWebUsbSupported(): boolean {
  return AdbDaemonWebUsbDeviceManager.BROWSER !== undefined;
}

export function androidDeviceInfo(device: AndroidUsbDevice): AndroidDeviceInfo {
  return { serial: device.serial, name: device.name || 'Android device' };
}

/**
 * Open the browser's WebUSB picker filtered to devices exposing an ADB
 * interface. Returns undefined when the user cancels the picker.
 */
export async function requestAndroidDevice(): Promise<AndroidUsbDevice | undefined> {
  const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
  if (!manager) {
    throw new Error(
      'WebUSB is not available. Use a Chromium-based browser (Chrome or Edge) over HTTPS.',
    );
  }
  return manager.requestDevice();
}

export type InstallApkOptions = {
  device: AndroidUsbDevice;
  source: AndroidApkSource;
  log?: AndroidInstallLog;
  onPhase?: (phase: AndroidInstallPhase) => void;
  /** Reports APK bytes streamed to the device. totalBytes is 0 when unknown. */
  onProgress?: (progress: AndroidInstallProgress) => void;
  /**
   * Name shown next to this browser's key in the phone's
   * "Wireless debugging -> Paired devices" list. Defaults to "Limrun".
   */
  credentialStoreName?: string;
};

/**
 * Install an APK onto a USB-connected Android device from the browser.
 *
 * Connects over WebUSB, authenticates with a persistent per-browser ADB key
 * (the phone shows its USB-debugging prompt on first use), and streams the
 * APK through `pm install`. Resolves when the device reports success.
 */
export async function installApk({
  device,
  source,
  log = noopLog,
  onPhase,
  onProgress,
  credentialStoreName,
}: InstallApkOptions): Promise<void> {
  let adb: Adb | undefined;
  try {
    onPhase?.('connecting');
    log('Connecting to device', device.serial);
    const connection = await device.connect();

    onPhase?.('authorizing');
    log('Authenticating', 'Accept the USB debugging prompt on the phone if it appears.');
    const transport = await AdbDaemonTransport.authenticate({
      serial: device.serial,
      connection,
      credentialStore: credentialStore(credentialStoreName),
    });
    adb = new Adb(transport);

    onPhase?.('installing');
    const { stream, size } = await resolveApkSource(source, log);
    log('Installing APK', size > 0 ? `${size} bytes` : undefined);
    let receivedBytes = 0;
    const progress = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        receivedBytes += chunk.byteLength;
        onProgress?.({ receivedBytes, totalBytes: size });
        controller.enqueue(chunk);
      },
    });
    const packageManager = new PackageManager(adb);
    // Tango declares its own ReadableStream type with async-iteration
    // members; the native stream is runtime-compatible.
    await packageManager.installStream(
      size,
      stream.pipeThrough(progress) as unknown as Parameters<PackageManager['installStream']>[1],
    );
    log('Install complete', device.serial);
  } catch (error) {
    throw new Error(friendlyAndroidInstallError(error));
  } finally {
    if (adb) {
      await adb.close().catch(() => undefined);
    }
  }
}

async function resolveApkSource(
  source: AndroidApkSource,
  log: AndroidInstallLog,
): Promise<{ stream: ReadableStream<Uint8Array>; size: number }> {
  if ('stream' in source) {
    return { stream: source.stream, size: source.size };
  }
  if ('file' in source) {
    return { stream: source.file.stream(), size: source.file.size };
  }
  log('Downloading APK');
  const response = await fetch(source.downloadUrl);
  if (!response.ok || !response.body) {
    throw new Error(
      `Downloading the APK failed with status ${response.status}. The link may have expired; get a fresh one and retry.`,
    );
  }
  const size = Number(response.headers.get('Content-Length') ?? 0);
  if (size > 0) {
    return { stream: response.body, size };
  }
  // Content-Length is missing, so buffer to learn the size that pm install
  // requires up front.
  const buffer = await response.arrayBuffer();
  return { stream: new Blob([buffer]).stream(), size: buffer.byteLength };
}

export function friendlyAndroidInstallError(error: unknown): string {
  if (error instanceof AdbDaemonWebUsbDevice.DeviceBusyError) {
    return 'The device is used by another program. Close Android Studio or run `adb kill-server`, replug the cable and try again.';
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/claim|access denied|unable to open/i.test(message)) {
    return `Could not open the USB connection: ${message}. If adb is running on this computer, run \`adb kill-server\` and try again.`;
  }
  if (/INSTALL_FAILED|Failure \[/.test(message)) {
    return `The device rejected the APK: ${message}`;
  }
  return message;
}

function noopLog() {
  // Intentionally empty. Consumers can pass a logger for progress messages.
}
