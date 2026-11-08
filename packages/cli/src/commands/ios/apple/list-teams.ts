import * as apple from '@limrun/apple-auth';
import { appleAction } from '../../../lib/store-action-command';

export default appleAction({
  summary: 'List teams',
  selectTeam: false,
  flags: {},
  run: async (context) => apple.listAppleTeams({ relay: context.relay }),
});
