import {
  cloudSigningFlagsProblem,
  hasCloudSigningFlags,
  hasSigningFlags,
  signingFlagsProblem,
} from './xcode-signing-options';

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

describe('cloudSigningFlagsProblem', () => {
  const complete = {
    'signing-method': 'release-testing',
    'team-id': 'TEAM123456',
    'asc-key-id': 'KEY123',
    'asc-issuer-id': 'issuer',
    'asc-key': 'AuthKey.p8',
  };

  it('accepts an absent group and a complete group', () => {
    expect(cloudSigningFlagsProblem({})).toBeUndefined();
    expect(cloudSigningFlagsProblem(complete)).toBeUndefined();
  });

  it('requires every cloud signing credential', () => {
    expect(cloudSigningFlagsProblem({ 'signing-method': 'debugging' })).toMatch(/--team-id.*--asc-key-id/);
    expect(cloudSigningFlagsProblem({ 'team-id': 'TEAM123456' })).toMatch(/requires --signing-method/);
  });

  it('rejects manual and cloud signing together', () => {
    expect(
      cloudSigningFlagsProblem({
        ...complete,
        'certificate-p12': 'dist.p12',
        'certificate-password': 'pw',
        'provisioning-profile': ['app.mobileprovision'],
      }),
    ).toMatch(/cannot be combined/);
  });
});

describe('hasCloudSigningFlags', () => {
  it('detects either cloud-signing-specific flag', () => {
    expect(hasCloudSigningFlags({})).toBe(false);
    expect(hasCloudSigningFlags({ 'signing-method': 'debugging' })).toBe(true);
    expect(hasCloudSigningFlags({ 'team-id': 'TEAM123456' })).toBe(true);
  });
});
