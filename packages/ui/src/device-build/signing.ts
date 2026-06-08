import {
  parseProvisioningProfile,
  profileContainsDevice,
  profileMatchesBundleID,
  putSigningAssets,
} from '../core/device-install/storage';
import type { DeviceInstallSigningMode, StoredSigningAssets } from '../core/device-install/types';

export type ImportSigningAssetsFromFilesInput = {
  certificateFile: File;
  provisioningProfileFile: File;
  certificatePassword?: string;
  bundleId?: string;
  deviceUDID?: string;
  teamId?: string;
  signingMode?: DeviceInstallSigningMode;
  certificateId?: string;
};

export type ValidateSigningAssetsOptions = {
  bundleId?: string;
  deviceUDID?: string;
  signingMode?: DeviceInstallSigningMode;
};

export async function importSigningAssetsFromFiles({
  certificateFile,
  provisioningProfileFile,
  certificatePassword,
  bundleId,
  deviceUDID,
  teamId,
  signingMode = 'development',
  certificateId,
}: ImportSigningAssetsFromFilesInput) {
  const [certificateP12Base64, provisioningProfileBase64, profile] = await Promise.all([
    fileToBase64(certificateFile),
    fileToBase64(provisioningProfileFile),
    parseProvisioningProfile(provisioningProfileFile),
  ]);
  validateProvisioningProfileForInstall({ profile, bundleId, deviceUDID, signingMode });
  return putSigningAssets({
    bundleID: bundleId ?? profile.bundleID ?? profile.applicationIdentifier ?? provisioningProfileFile.name,
    deviceUDID,
    teamID: teamId ?? profile.teamID,
    signingMode,
    certificateID: certificateId,
    certificateP12Base64,
    certificateFileName: certificateFile.name,
    certificatePassword: certificatePassword || undefined,
    provisioningProfileBase64,
    profileFileName: provisioningProfileFile.name,
    profile,
  });
}

export function validateSigningAssetsForInstall(
  assets: StoredSigningAssets,
  options: ValidateSigningAssetsOptions = {},
) {
  validateProvisioningProfileForInstall({
    profile: assets.profile,
    bundleId: options.bundleId,
    deviceUDID: options.deviceUDID,
    signingMode: options.signingMode ?? assets.signingMode,
  });
}

export function validateProvisioningProfileForInstall({
  profile,
  bundleId,
  deviceUDID,
  signingMode,
}: Pick<StoredSigningAssets, 'profile'> & ValidateSigningAssetsOptions) {
  if (bundleId && !profileMatchesBundleID(profile, bundleId)) {
    throw new Error(`Provisioning profile does not match bundle ID ${bundleId}.`);
  }
  if (deviceUDID && !profileContainsDevice(profile, deviceUDID)) {
    throw new Error('Provisioning profile does not include the selected iPhone.');
  }
  if (signingMode === 'adhoc' && profile.getTaskAllow) {
    throw new Error('Ad Hoc mode requires an Ad Hoc provisioning profile, not a development profile.');
  }
}

export async function fileToBase64(file: File) {
  const buffer = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
