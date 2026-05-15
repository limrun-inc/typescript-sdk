const { launchExpoGoDetoxAppFromEnv } = require('@limrun/detox');

const waitForVisible = (testID) => waitFor(element(by.id(testID))).toBeVisible().withTimeout(30000);
const waitForExisting = (testID) => waitFor(element(by.id(testID))).toExist().withTimeout(30000);
const pauseForWatching = () => new Promise((resolve) => setTimeout(resolve, 700));

const openCard = async ({ cardID, title }) => {
  await waitForVisible(cardID);
  await pauseForWatching();
  await element(by.text(title)).tap();
};

const openTab = async (label, screenID) => {
  await pauseForWatching();
  await element(by.label(label).and(by.type('_UITabButton'))).atIndex(0).tap();
  await waitForExisting(screenID);
  await pauseForWatching();
};

describe('Liquid Stays on Limrun iOS', () => {
  beforeAll(async () => {
    await launchExpoGoDetoxAppFromEnv();
    await device.disableSynchronization();
  }, 120000);

  it('browses stays and reviews the booking payment page', async () => {
    await waitForVisible('explore-screen');
    await waitForVisible('search-pill');
    await waitForVisible('category-cabins');

    await openTab('Wishlists', 'wishlists-screen');
    await openTab('Trips', 'trips-screen');
    await openTab('Inbox', 'inbox-screen');
    await openTab('Profile', 'profile-screen');
    await openTab('Explore', 'explore-screen');
    await waitForVisible('category-cabins');

    await pauseForWatching();
    await element(by.id('category-cabins')).tap();
    await waitForVisible('property-card-p2');
    await expect(element(by.text('Aspen, Colorado'))).toBeVisible();
    await expect(element(by.text('A-frame retreat in pine forest'))).toBeVisible();
    await pauseForWatching();

    await openCard({ cardID: 'property-card-p2', title: 'A-frame retreat in pine forest' });
    await waitForVisible('reserve-btn');
    await waitForVisible('detail-heart');
    await pauseForWatching();

    await element(by.id('reserve-btn')).tap();
    await waitForExisting('booking-screen');
    await waitForVisible('nights-plus');
    await waitForVisible('guests-plus');
    await pauseForWatching();

    await element(by.id('nights-plus')).tap();
    await pauseForWatching();
    await element(by.id('guests-plus')).tap();
    await expect(element(by.text('Visa · ending 4242'))).toBeVisible();
    await pauseForWatching();
  });
});