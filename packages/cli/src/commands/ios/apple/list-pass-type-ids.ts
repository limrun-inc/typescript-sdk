import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'List pass type IDs',
  flags: {},
  run: async (context) => apple.listApplePassTypeIDs({ relay: context.relay, teamId: context.team!.teamId }),
});
