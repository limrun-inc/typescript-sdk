import { targetHttpPortUrlPrefixFromApiUrl } from './maestro';

describe('targetHttpPortUrlPrefixFromApiUrl', () => {
  it('replaces the trailing /api with /targetHttpPort', () => {
    expect(targetHttpPortUrlPrefixFromApiUrl('https://region.limrun.net/v1/ios_x/api')).toBe(
      'https://region.limrun.net/v1/ios_x/targetHttpPort',
    );
  });

  it('accepts a trailing slash after /api', () => {
    expect(targetHttpPortUrlPrefixFromApiUrl('https://region.limrun.net/v1/ios_x/api/')).toBe(
      'https://region.limrun.net/v1/ios_x/targetHttpPort',
    );
  });

  it('returns undefined when the URL does not end in /api', () => {
    expect(targetHttpPortUrlPrefixFromApiUrl('https://region.limrun.net/v1/ios_x')).toBeUndefined();
  });

  it('does not replace /api in the middle of the path', () => {
    expect(
      targetHttpPortUrlPrefixFromApiUrl('https://region.limrun.net/api/v1/ios_x/control'),
    ).toBeUndefined();
  });
});
