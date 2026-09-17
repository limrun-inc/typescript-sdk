import { forwardRef } from 'react';
import {
  RemoteControl as RemoteControlBase,
  type RemoteControlHandle,
  type RemoteControlProps,
} from './remote-control';
import { defaultRemoteControlAssets } from '../frame-assets';

// The default export: RemoteControl with Limrun's device frames unless the
// caller supplies its own assets.
export const RemoteControl = forwardRef<RemoteControlHandle, RemoteControlProps>((props, ref) => (
  <RemoteControlBase ref={ref} assets={defaultRemoteControlAssets} {...props} />
));
RemoteControl.displayName = 'RemoteControl';
