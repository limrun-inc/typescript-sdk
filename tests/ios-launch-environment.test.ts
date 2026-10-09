import { parseLaunchEnvironment, validateLaunchEnvironment } from '../src/ios-launch-environment';

test('handles object property names without prototype mutation', () => {
  const env = parseLaunchEnvironment(['__proto__=value', 'constructor=other']);
  expect(Object.keys(env)).toEqual(['__proto__', 'constructor']);
  expect(env['__proto__']).toBe('value');
});

test('bounds environment payload size and entry count', () => {
  expect(() =>
    validateLaunchEnvironment(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`K${i}`, '']))),
  ).toThrow('64 entries');
  expect(() => validateLaunchEnvironment({ KEY: 'x'.repeat(8193) })).toThrow('invalid');
  expect(() =>
    validateLaunchEnvironment(
      Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`K${i}`, 'x'.repeat(8192)])),
    ),
  ).toThrow('65536');
});
