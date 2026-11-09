import { addToBlocklist, removeFromBlocklist } from './blocklist';

test('adding keeps the list and skips names it already holds', () => {
  expect(addToBlocklist(['facebook.com'], ['FACEBOOK.com', '*.facebook.com', '*.facebook.com'])).toEqual([
    'facebook.com',
    '*.facebook.com',
  ]);
});

test('removing drops the named entries and ignores names the list does not hold', () => {
  expect(removeFromBlocklist(['facebook.com', '*.facebook.com'], ['Facebook.com', 'instagram.com'])).toEqual([
    '*.facebook.com',
  ]);
});
