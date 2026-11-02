import { type IosInstanceCreateParams } from '@limrun/api/resources/ios-instances';

export type IosModel = NonNullable<IosInstanceCreateParams.Spec['model']>;

/** iOS major versions the --os-version flags accept, and which model runs which. */
export const IOS_OS_VERSIONS = ['26', '27'];
export const IOS_OS_VERSION_SUPPORT = 'iPhone and iPad run both, iPhone Duo 27, Watch 26.';

/** Maps the --os-version and --model flags to the create spec fields that select the simulator. */
export function iosDeviceSelection(osVersion?: string, model?: IosModel): IosInstanceCreateParams.Spec {
  const spec: IosInstanceCreateParams.Spec = {};
  if (osVersion) {
    spec.clues = [{ kind: 'OSVersion', osVersion }];
  }
  if (model) {
    spec.model = model;
  }
  return spec;
}
