// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildDeviceModel, resolveDeviceKind } from './device-model';

describe('resolveDeviceKind', () => {
  it('android platform is always the android model', () => {
    expect(resolveDeviceKind('android', 'auto', 0.9)).toBe('android');
    expect(resolveDeviceKind('android', 'watch', 0.9)).toBe('android');
    expect(resolveDeviceKind('android', 'phone', null)).toBe('android');
  });

  it('explicit hints win over the stream aspect', () => {
    expect(resolveDeviceKind('ios', 'watch', 9 / 19.5)).toBe('watch');
    expect(resolveDeviceKind('ios', 'phone', 0.84)).toBe('ios');
  });

  it('auto-detects a watch from a nearly square stream', () => {
    // Apple Watch simulator resolutions (portrait aspect ~0.82-0.84).
    expect(resolveDeviceKind('ios', 'auto', 416 / 496)).toBe('watch');
    expect(resolveDeviceKind('ios', 'auto', 396 / 484)).toBe('watch');
    expect(resolveDeviceKind('ios', 'auto', 410 / 502)).toBe('watch');
  });

  it('keeps phones and tablets as iPhone in auto mode', () => {
    expect(resolveDeviceKind('ios', 'auto', 9 / 19.5)).toBe('ios'); // iPhone
    expect(resolveDeviceKind('ios', 'auto', 2048 / 2732)).toBe('ios'); // iPad Pro
    expect(resolveDeviceKind('ios', 'auto', null)).toBe('ios'); // stream not up yet
  });
});

describe('buildDeviceModel', () => {
  it.each(['ios', 'android', 'watch'] as const)('builds and disposes a %s model', (kind) => {
    const model = buildDeviceModel(kind, kind === 'watch' ? 0.84 : 9 / 19.5);
    expect(model.group.children.length).toBeGreaterThan(0);
    expect(model.boundingRadius).toBeGreaterThan(0);
    expect(() => {
      model.setLandscape(true);
      model.setLandscape(false);
      model.setScreenTexture(null);
      model.dispose();
    }).not.toThrow();
  });

  it('the watch bounding sphere includes the band straps', () => {
    const watch = buildDeviceModel('watch', 0.84);
    const phone = buildDeviceModel('ios', 9 / 19.5);
    // Straps extend well past the case, so the watch needs a larger fit
    // radius than a phone despite the smaller case.
    expect(watch.boundingRadius).toBeGreaterThan(phone.boundingRadius);
    watch.dispose();
    phone.dispose();
  });
});
