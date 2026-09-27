import { instanceToken } from '@limrun/api/instance-token';

describe('instanceToken', () => {
  test('returns the token of a record read with control', () => {
    expect(instanceToken({ metadata: { id: 'ios_euna_01a' }, status: { token: 'lim_st_x' } })).toBe(
      'lim_st_x',
    );
  });

  test('explains a record read without control instead of returning an empty token', () => {
    expect(() => instanceToken({ metadata: { id: 'ios_euna_01a' }, status: {} })).toThrow(
      'Instance ios_euna_01a came back without its token: the credential used can read it but not control it.',
    );
  });
});
