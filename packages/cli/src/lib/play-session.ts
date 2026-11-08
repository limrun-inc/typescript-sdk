import { Flags } from '@oclif/core';
import { readFile } from 'node:fs/promises';
import { savedGoogleAccessToken } from './google-auth';

export const playSessionFlags = {
  'access-token-file': Flags.string({
    description: 'File containing a Google OAuth access token. Overrides the saved Play login.',
  }),
};

export async function playAccessToken(flags: { 'access-token-file'?: string }): Promise<string> {
  const token =
    flags['access-token-file'] ?
      (await readFile(flags['access-token-file'], 'utf8')).trim()
    : await savedGoogleAccessToken();
  if (!token) throw new Error('Run lim android play auth first, or provide --access-token-file.');
  return token;
}
