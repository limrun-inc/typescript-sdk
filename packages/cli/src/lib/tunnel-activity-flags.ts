import { Flags } from '@oclif/core';

/** Activity flag shared by `ios tunnel`, `android tunnel` and `tunnel run`. */
export const tunnelActivityFlags = {
  'reset-inactivity-timeout': Flags.boolean({
    description:
      "Count tunnel traffic as instance activity, which resets the instance's inactivity timeout. " +
      'Use --no-reset-inactivity-timeout when the traffic does not mean anyone is using the device, ' +
      'such as a dev server that keeps polling the app.',
    default: true,
    allowNo: true,
  }),
};
