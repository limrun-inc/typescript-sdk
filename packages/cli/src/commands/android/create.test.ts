import AndroidCreate, { androidDeviceSelection } from './create';

test('Android 15 tablet selection maps to separate OS and model fields', () => {
  expect(androidDeviceSelection('15', 'tablet')).toEqual({
    clues: [{ kind: 'OSVersion', osVersion: '15' }],
    model: 'tablet',
  });
});

test('Android create exposes supported OS versions and models', () => {
  expect(AndroidCreate.flags['os-version'].options).toEqual(['14', '15']);
  expect(AndroidCreate.flags.model.options).toEqual(['phone', 'tablet']);
});
