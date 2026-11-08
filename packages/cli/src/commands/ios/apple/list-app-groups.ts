import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'List app groups',
  flags: {},
  run: async (context) => apple.listAppleAppGroups({ relay: context.relay, teamId: context.team!.teamId }),
});
