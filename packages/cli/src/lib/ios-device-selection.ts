import { type IosInstanceCreateParams } from '@limrun/api/resources/ios-instances';

export type IosModel = NonNullable<IosInstanceCreateParams.Spec['model']>;

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
