import {
  buildManualInstanceRecord,
  envInstanceTarget,
  instanceIdFromToken,
  syntheticInstanceId,
} from './set-instance';

function signedToken(scopes: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: 'limrun', sub: 'org_01abc', scopes })).toString(
    'base64url',
  );
  return `lim_st_${header}.${payload}.c2lnbmF0dXJl`;
}

const IOS_TID = 'ios_euna_01m02anjqredzr42pcn8s8jx90';
const SANDBOX_TID = 'sandbox_euna_01m02anjqredzr42pcn8s8jx90';

describe('instanceIdFromToken', () => {
  it('extracts the instance id from a matching scope', () => {
    expect(instanceIdFromToken(signedToken([`ios:${IOS_TID}:all`]), 'ios')).toBe(IOS_TID);
  });

  it('picks the scope whose resource matches the topic among several', () => {
    const token = signedToken(['android:android_euna_01abc:all', `ios:${IOS_TID}:all`]);
    expect(instanceIdFromToken(token, 'ios')).toBe(IOS_TID);
    expect(instanceIdFromToken(token, 'android')).toBe('android_euna_01abc');
  });

  it('maps sandbox tids to the xcode topic', () => {
    expect(instanceIdFromToken(signedToken([`xcode:${SANDBOX_TID}:all`]), 'xcode')).toBe(SANDBOX_TID);
  });

  it('yields nothing for wildcard scopes', () => {
    expect(instanceIdFromToken(signedToken(['ios:*:all']), 'ios')).toBeUndefined();
  });

  it('yields nothing for legacy opaque tokens', () => {
    expect(instanceIdFromToken('random-opaque-token', 'ios')).toBeUndefined();
  });

  it('yields nothing for a scope whose id prefix contradicts its resource', () => {
    expect(instanceIdFromToken(signedToken([`ios:${SANDBOX_TID}:all`]), 'ios')).toBeUndefined();
  });

  it('survives malformed payloads', () => {
    expect(instanceIdFromToken('lim_st_not.a.jwt', 'ios')).toBeUndefined();
    expect(instanceIdFromToken(signedToken('not-an-array'), 'ios')).toBeUndefined();
  });
});

describe('syntheticInstanceId', () => {
  it('is deterministic per apiUrl and carries the type prefix', () => {
    const a = syntheticInstanceId('ios', 'https://region.limrun.com/v1/x/api');
    expect(a).toBe(syntheticInstanceId('ios', 'https://region.limrun.com/v1/x/api'));
    expect(a).toMatch(/^ios_local_[0-9a-f]{12}$/);
    expect(syntheticInstanceId('ios', 'https://other.limrun.com/v1/y/api')).not.toBe(a);
  });
});

describe('buildManualInstanceRecord', () => {
  it('uses the token id when the token names one', () => {
    const record = buildManualInstanceRecord({
      type: 'ios',
      apiUrl: 'https://region.limrun.com/v1/x/api',
      token: signedToken([`ios:${IOS_TID}:all`]),
    });
    expect(record).toEqual({
      id: IOS_TID,
      type: 'ios',
      apiUrl: 'https://region.limrun.com/v1/x/api',
      token: signedToken([`ios:${IOS_TID}:all`]),
    });
  });

  it('falls back to a synthetic handle for legacy tokens', () => {
    const record = buildManualInstanceRecord({
      type: 'gradle',
      apiUrl: 'https://region.limrun.com/v1/x/api',
      token: 'opaque',
    });
    expect(record.id).toMatch(/^gradle_local_[0-9a-f]{12}$/);
    expect(record.type).toBe('gradle');
  });

  it('keeps the ADB websocket URL on android records', () => {
    const record = buildManualInstanceRecord({
      type: 'android',
      apiUrl: 'https://region.limrun.com/v1/x/api',
      token: 'opaque',
      adbWebSocketUrl: 'wss://region.limrun.com/adb',
    });
    expect(record).toMatchObject({ type: 'android', adbWebSocketUrl: 'wss://region.limrun.com/adb' });
  });
});

describe('envInstanceTarget', () => {
  const VARS = [
    'LIM_IOS_INSTANCE_URL',
    'LIM_IOS_INSTANCE_TOKEN',
    'LIM_ANDROID_INSTANCE_URL',
    'LIM_ANDROID_INSTANCE_TOKEN',
    'LIM_ANDROID_INSTANCE_ADB_URL',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of VARS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it('returns null unless both URL and token are set', () => {
    expect(envInstanceTarget('ios')).toBeNull();
    process.env['LIM_IOS_INSTANCE_URL'] = 'https://region.limrun.com/v1/x/api';
    expect(envInstanceTarget('ios')).toBeNull();
    process.env['LIM_IOS_INSTANCE_TOKEN'] = signedToken([`ios:${IOS_TID}:all`]);
    expect(envInstanceTarget('ios')).toMatchObject({ id: IOS_TID, type: 'ios' });
  });

  it('includes the ADB URL for android when set', () => {
    process.env['LIM_ANDROID_INSTANCE_URL'] = 'https://region.limrun.com/v1/x/api';
    process.env['LIM_ANDROID_INSTANCE_TOKEN'] = 'opaque';
    process.env['LIM_ANDROID_INSTANCE_ADB_URL'] = 'wss://region.limrun.com/adb';
    expect(envInstanceTarget('android')).toMatchObject({
      type: 'android',
      adbWebSocketUrl: 'wss://region.limrun.com/adb',
    });
  });
});
