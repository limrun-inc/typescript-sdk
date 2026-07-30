import { hasSigningFlags, signingFlagsProblem } from './xcode-signing-options';

describe('signingFlagsProblem', () => {
  it('accepts an absent group and a complete group', () => {
    expect(signingFlagsProblem({})).toBeUndefined();
    expect(
      signingFlagsProblem({
        'certificate-p12': 'dist.p12',
        'certificate-password': 'pw',
        'provisioning-profile': ['app', 'widgets'],
      }),
    ).toBeUndefined();
  });

  it('rejects a partial group', () => {
    expect(signingFlagsProblem({ 'provisioning-profile': ['app'] })).toMatch(/--certificate-p12/);
  });

  it('treats an empty-string password as provided, not missing', () => {
    expect(
      signingFlagsProblem({
        'certificate-p12': 'dist.p12',
        'certificate-password': '',
        'provisioning-profile': ['app'],
      }),
    ).toBeUndefined();
  });
});

describe('hasSigningFlags', () => {
  it('detects any signing flag, so a partial group can be rejected', () => {
    expect(hasSigningFlags({})).toBe(false);
    expect(hasSigningFlags({ 'certificate-password': '' })).toBe(true);
    expect(hasSigningFlags({ 'provisioning-profile': ['app'] })).toBe(true);
  });
});
