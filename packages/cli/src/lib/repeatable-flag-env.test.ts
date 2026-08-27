import { repeatableFlagFromEnv } from './repeatable-flag-env';

describe('repeatableFlagFromEnv', () => {
  const VAR = 'LIM_TEST_REPEATABLE';
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[VAR];
    delete process.env[VAR];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[VAR];
    else process.env[VAR] = saved;
  });

  it('returns nothing when the variable is unset or holds no entries', () => {
    expect(repeatableFlagFromEnv(VAR)).toBeUndefined();
    process.env[VAR] = '';
    expect(repeatableFlagFromEnv(VAR)).toBeUndefined();
    process.env[VAR] = ',,';
    expect(repeatableFlagFromEnv(VAR)).toBeUndefined();
  });

  it('splits on unescaped commas', () => {
    // One value carrying all three cases: an escaped comma inside a
    // SigV4-style Authorization, a real separator, and the trailing one a
    // concatenating wrapper leaves behind.
    process.env[VAR] = 'Authorization=AWS4-HMAC-SHA256 Credential=x\\, Signature=y,X-Trace=abc,';
    expect(repeatableFlagFromEnv(VAR)).toEqual([
      'Authorization=AWS4-HMAC-SHA256 Credential=x, Signature=y',
      'X-Trace=abc',
    ]);
  });
});
