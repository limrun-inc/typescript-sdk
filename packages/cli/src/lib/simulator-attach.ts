import {
  type SimulatorAttachResult,
  type SimulatorBuildStatus,
} from '@limrun/api/resources/xcode-instances-helpers';

export function formatSimulatorAttachResult(
  simulatorInstanceId: string,
  xcodeInstanceId: string,
  result: SimulatorAttachResult,
): string {
  const prefix =
    result.alreadyAttached ?
      `Simulator ${simulatorInstanceId} is already attached to Xcode target ${xcodeInstanceId}`
    : `Attached simulator ${simulatorInstanceId} to Xcode target ${xcodeInstanceId}`;
  if (result.installedLastBuild && result.latestBuild) {
    return `${prefix}; installed and launched latest build ${formatBuild(result.latestBuild)}`;
  }
  if (result.installError) {
    return `${prefix}; failed to install latest build: ${result.installError}`;
  }
  if (!result.latestBuild) {
    return `${prefix}; no installable simulator build found`;
  }
  if (result.latestBuild.installState === 'installedOnAttachedSimulator') {
    return `${prefix}; latest build ${formatBuild(result.latestBuild)} is already installed`;
  }
  return prefix;
}

export function simulatorAttachJson(
  simulatorInstanceId: string,
  xcodeInstanceId: string,
  result: SimulatorAttachResult,
) {
  return {
    xcodeInstanceId,
    simulatorInstanceId,
    ...result,
  };
}

function formatBuild(build: SimulatorBuildStatus): string {
  return build.bundleId ? `${build.buildId} (${build.bundleId})` : build.buildId;
}
