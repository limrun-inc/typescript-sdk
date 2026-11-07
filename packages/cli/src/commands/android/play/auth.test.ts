import { Parser } from '@oclif/core';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import PlayAuth from './auth';
import { authenticateGoogle } from '../../../lib/google-auth';
import { LIMRUN_GOOGLE_DESKTOP_CLIENT } from '../../../lib/google-desktop-client';

jest.mock('../../../lib/google-auth', () => ({
  ...jest.requireActual('../../../lib/google-auth'),
  authenticateGoogle: jest.fn(),
}));

async function run(argv: string[]) {
  const parsed = await Parser.parse(argv, { flags: PlayAuth.flags });
  const command = Object.assign(Object.create(PlayAuth.prototype), {
    parse: async () => parsed,
    setParsedFlags: jest.fn(),
    info: jest.fn(),
  });
  await command.run();
}

beforeEach(() => jest.mocked(authenticateGoogle).mockClear());

test('plain play auth starts browser login with the bundled desktop client', async () => {
  await run([]);
  expect(authenticateGoogle).toHaveBeenCalledWith(
    LIMRUN_GOOGLE_DESKTOP_CLIENT,
    expect.any(Function),
    expect.anything(),
    fetch,
    undefined,
  );
});

test('a supplied desktop client overrides the bundled client', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lim-client-'));
  try {
    const file = path.join(directory, 'client.json');
    await writeFile(
      file,
      JSON.stringify({
        installed: { client_id: 'custom.apps.googleusercontent.com', client_secret: 'custom-secret' },
      }),
    );
    await run(['--client-config', file]);
    expect(jest.mocked(authenticateGoogle).mock.calls[0]![0]).toEqual({
      clientId: 'custom.apps.googleusercontent.com',
      clientSecret: 'custom-secret',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
