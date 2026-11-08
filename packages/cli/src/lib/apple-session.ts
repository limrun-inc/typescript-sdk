import { Flags } from '@oclif/core';
import {
  startAppleIDLogin,
  listAppleTeams,
  type AppleRelayWebSocketClient,
  type AppleTeam,
} from '@limrun/apple-auth';
import prompts from 'prompts';
import { LocalSecretStore } from './local-secret-store';

export const appleSessionFlags = {
  account: Flags.string({ description: 'Apple Account email address.' }),
  'team-id': Flags.string({
    description: 'Apple Developer team ID. Prompts when several teams are available.',
  }),
  'registry-endpoint': Flags.string({
    description: 'Registry hosting the Apple relay.',
    env: 'LIM_REGISTRY_ENDPOINT',
    default: 'https://registry.limrun.com',
  }),
};
export interface AppleSessionContext {
  relay: AppleRelayWebSocketClient;
  team?: AppleTeam;
  store: LocalSecretStore;
}
export async function withAppleSession<T>(
  token: string,
  flags: { account?: string; 'team-id'?: string; 'registry-endpoint': string },
  action: (context: AppleSessionContext) => Promise<T>,
  selectTeam = true,
): Promise<T> {
  if (!process.stdin.isTTY) throw new Error('Apple sign-in requires an interactive terminal.');
  const promptOptions = {
    onCancel: () => {
      throw new Error('Apple sign-in cancelled.');
    },
  };
  const answers = await prompts(
    [
      {
        type: flags.account ? null : 'text',
        name: 'account',
        message: 'Apple Account email',
        validate: (value: string) => !!value.trim(),
      },
      {
        type: 'password',
        name: 'password',
        message: 'Apple Account password',
        validate: (value: string) => !!value,
      },
    ],
    promptOptions,
  );
  let session;
  try {
    session = await startAppleIDLogin({
      registryApiUrl: flags['registry-endpoint'],
      token,
      accountName: flags.account ?? answers.account,
      password: answers.password,
    });
  } finally {
    delete answers.password;
  }
  try {
    if (session.requiresTwoFactor) {
      const { code } = await prompts(
        {
          type: 'password',
          name: 'code',
          message: 'Apple verification code',
          validate: (value: string) => /^\d{6}$/.test(value),
        },
        promptOptions,
      );
      await session.finishTwoFactor(code);
    }
    const finalized = await session.finalize();
    if (finalized.status < 200 || finalized.status >= 300)
      throw new Error('Apple could not finalize the sign-in.');
    if (!selectTeam) return await action({ relay: session.relay, store: new LocalSecretStore() });
    const teams = await listAppleTeams({ relay: session.relay });
    if (!teams.length) throw new Error('This Apple Account has no Developer teams.');
    let team = flags['team-id'] ? teams.find((team) => team.teamId === flags['team-id']) : undefined;
    if (flags['team-id'] && !team)
      throw new Error('The requested team is not available to this Apple Account.');
    if (!team && teams.length === 1) team = teams[0];
    if (!team) {
      const { teamId } = await prompts(
        {
          type: 'select',
          name: 'teamId',
          message: 'Apple Developer team',
          choices: teams.map((team) => ({
            title: `${team.name ?? team.teamId} (${team.teamId})`,
            value: team.teamId,
          })),
        },
        promptOptions,
      );
      team = teams.find((team) => team.teamId === teamId)!;
    }
    return await action({ relay: session.relay, team, store: new LocalSecretStore() });
  } finally {
    await session.close();
  }
}
