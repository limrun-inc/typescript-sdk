import { parseLaunchEnvironment } from '../src/ios-launch-environment';

test('handles object property names without prototype mutation', () => {
  const env = parseLaunchEnvironment(['__proto__=value', 'constructor=other']);
  expect(Object.keys(env)).toEqual(['__proto__', 'constructor']);
  expect(env['__proto__']).toBe('value');
});
