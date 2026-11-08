import type { GoogleDesktopClient } from '@limrun/play-auth';

// Google Desktop app clients are public. These identify Limrun, not the user;
// access still requires browser consent and the per-login PKCE verifier.
export const LIMRUN_GOOGLE_DESKTOP_CLIENT: GoogleDesktopClient = {
  clientId: '674508286747-29kdn9sc04oavfea1jek97i7rbsaod90.apps.googleusercontent.com',
  clientSecret: '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',
};
