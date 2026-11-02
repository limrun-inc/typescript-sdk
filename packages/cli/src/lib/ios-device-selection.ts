import type { XcodeClient } from '@limrun/api';
import { type IosInstanceCreateParams } from '@limrun/api/resources/ios-instances';

/** The spec fields that select a simulator: its model and an OSVersion clue. */
export type IosDeviceSelection = NonNullable<Parameters<XcodeClient['attachNewSimulator']>[0]>;

/** iOS models and major versions the --model and --os-version flags accept. */
export const IOS_MODELS: NonNullable<IosInstanceCreateParams.Spec['model']>[] = [
  'iphone',
  'iphone-duo',
  'ipad',
  'watch',
];
export const IOS_OS_VERSIONS = ['26', '27'];

/** Maps the --os-version and --model flag values to the spec fields that select the simulator. */
export function iosDeviceSelection(osVersion?: string, model?: string): IosDeviceSelection {
  const spec: IosDeviceSelection = {};
  if (osVersion) {
    spec.clues = [{ kind: 'OSVersion', osVersion }];
  }
  if (model) {
    spec.model = model as NonNullable<IosDeviceSelection['model']>;
  }
  return spec;
}
