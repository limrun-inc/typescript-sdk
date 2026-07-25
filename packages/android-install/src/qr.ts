import QRCode from 'qrcode';

export type ApkQrCodeOptions = {
  /** Rendered size in pixels. Defaults to 280. */
  width?: number;
  /** Quiet-zone margin in modules. Defaults to 1. */
  margin?: number;
};

/**
 * Render a download URL (typically a signed asset URL from the Limrun assets
 * API) as a QR code PNG data URL, for phones to scan and side-load the APK.
 */
export async function apkQrCodeDataUrl(
  downloadUrl: string,
  options: ApkQrCodeOptions = {},
): Promise<string> {
  return QRCode.toDataURL(downloadUrl, {
    width: options.width ?? 280,
    margin: options.margin ?? 1,
    errorCorrectionLevel: 'M',
  });
}
