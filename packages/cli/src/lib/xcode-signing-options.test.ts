import {
  cloudSigningFlagsProblem,
  hasCloudSigningFlags,
  hasSigningFlags,
  parseEntitlementsEntries,
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

describe('parseEntitlementsEntries', () => {
  it('treats a bare path as the app entry', () => {
    expect(parseEntitlementsEntries(['./app.entitlements'])).toEqual({
      entries: [{ bundleId: '', path: './app.entitlements' }],
    });
  });

  it('splits bundleId=path entries', () => {
    expect(parseEntitlementsEntries(['com.example.app.widgets=./w.entitlements'])).toEqual({
      entries: [{ bundleId: 'com.example.app.widgets', path: './w.entitlements' }],
    });
  });

  it('combines a bare path with bundle entries', () => {
    expect(
      parseEntitlementsEntries(['app.entitlements', 'com.example.app.widgets=w.entitlements']).entries,
    ).toHaveLength(2);
  });

  it('keeps paths containing = when the prefix is not a bundle id', () => {
    expect(parseEntitlementsEntries(['./builds/name=prod/app.entitlements'])).toEqual({
      entries: [{ bundleId: '', path: './builds/name=prod/app.entitlements' }],
    });
  });

  it('rejects a second bare path', () => {
    expect(parseEntitlementsEntries(['a.entitlements', 'b.entitlements']).problem).toMatch(
      /at most one bare path/,
    );
  });

  it('rejects a duplicate bundle id', () => {
    expect(parseEntitlementsEntries(['com.example.a=x.plist', 'com.example.a=y.plist']).problem).toMatch(
      /provided twice/,
    );
  });

  it('rejects an empty path after the bundle id', () => {
    expect(parseEntitlementsEntries(['com.example.a=']).problem).toMatch(/missing the plist path/);
  });

  it('requires --signing-method through cloudSigningFlagsProblem', () => {
    expect(cloudSigningFlagsProblem({ entitlements: ['app.entitlements'] })).toBe(
      '--entitlements requires --signing-method.',
    );
  });
});
