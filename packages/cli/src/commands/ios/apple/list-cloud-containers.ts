import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'List cloud containers',
  flags: {},
  run: async (context) =>
    apple.listAppleCloudContainers({ relay: context.relay, teamId: context.team!.teamId }),
});
