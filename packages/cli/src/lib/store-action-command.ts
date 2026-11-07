import { Command, type Interfaces } from '@oclif/core';
import { switchAppStoreConnectProvider } from '@limrun/apple-auth';
import { BaseCommand } from '../base-command';
import { appleSessionFlags, withAppleSession, type AppleSessionContext } from './apple-session';

export function appleAction<F extends Interfaces.FlagInput>(input: {
  summary: string;
  description?: string;
  flags: F;
  selectTeam?: boolean;
  appStoreConnect?: boolean;
  run: (context: AppleSessionContext, flags: Interfaces.InferredFlags<F>) => Promise<unknown>;
}): typeof Command {
  return class extends BaseCommand {
    static summary = input.summary;
    static description =
      input.description ??
      'Uses a fresh interactive Apple session. Results are JSON; private downloads require --output.';
    static flags = { ...BaseCommand.baseFlags, ...appleSessionFlags, ...input.flags };
    async run(): Promise<void> {
      const { flags } = await this.parse(this.constructor as typeof Command);
      this.setParsedFlags(flags);
      const { token } = await this.withAuth(() =>
        this.client.accessTokens.create({ scopes: ['applerelay:*:connect'] }),
      );
      const result = await withAppleSession(
        token,
        flags as Interfaces.InferredFlags<typeof appleSessionFlags>,
        async (context) => {
          if (input.appStoreConnect) {
            if (!context.team?.providerId)
              throw new Error('The selected team has no App Store Connect provider ID.');
            await switchAppStoreConnectProvider({
              relay: context.relay,
              providerId: context.team.providerId,
            });
          }
          return input.run(context, flags as Interfaces.InferredFlags<F>);
        },
        input.selectTeam,
      );
      this.outputJson(result ?? { ok: true });
    }
  };
}
