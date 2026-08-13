export const INSTALLER_NAME = 'Acme Device Installer';

export const naming = {
  certificateCommonName: (teamId: string) => `${INSTALLER_NAME} ${teamId}`,
  profileName: (bundleId: string, deviceUDID: string) =>
    `${INSTALLER_NAME} QR ${bundleId} ${deviceUDID.slice(-6)} ${Date.now()}`,
  deviceName: (productName: string, deviceUDID: string) =>
    `${INSTALLER_NAME} ${productName || 'iPhone'} ${deviceUDID.slice(-6)}`,
};

export const BACKEND_URL = 'http://localhost:3000';
