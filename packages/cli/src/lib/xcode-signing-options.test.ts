import { hasSigningFlags, signingConfigFromMaterial, signingFlagsProblem } from './xcode-signing-options';

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

describe('signingConfigFromMaterial', () => {
  it('uses the single-profile field for one profile so older limbuild servers keep working', () => {
    expect(signingConfigFromMaterial('cert', 'pw', ['app-profile'])).toEqual({
      certificateP12Base64: 'cert',
      certificatePassword: 'pw',
      provisioningProfileBase64: 'app-profile',
    });
  });

  it('uses ONLY the array field for multiple profiles', () => {
    const config = signingConfigFromMaterial('cert', 'pw', ['app-profile', 'widget-profile']);
    expect(config).toEqual({
      certificateP12Base64: 'cert',
      certificatePassword: 'pw',
      provisioningProfilesBase64: ['app-profile', 'widget-profile'],
    });
    expect(config.provisioningProfileBase64).toBeUndefined();
  });
});
