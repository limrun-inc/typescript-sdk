const { launchExpoGoDetoxAppFromEnv } = require('@limrun/detox');

const selectors = {
  homeScreen: 'demo-home-screen',
  homeTitle: 'demo-home-title',
  counterValue: 'demo-counter-value',
  incrementButton: 'demo-increment-button',
  decrementButton: 'demo-decrement-button',
  nameInput: 'demo-name-input',
  submitNameButton: 'demo-submit-name-button',
  greetingMessage: 'demo-greeting-message',
  openDetailButton: 'demo-open-detail-button',
  detailScreen: 'demo-detail-screen',
  automationSwitch: 'demo-automation-switch',
  completeTaskButton: 'demo-complete-task-button',
  successMessage: 'demo-success-message',
};

describe('Limrun Detox Expo sample app', () => {
  beforeAll(async () => {
    process.env.DETOX_EXPECTED_TEXT = 'Limrun Expo Test App';
    await launchExpoGoDetoxAppFromEnv();
    await device.disableSynchronization();
  }, 120000);

  it('drives the sample Expo app on a Limrun iOS simulator', async () => {
    await expect(element(by.id(selectors.homeTitle))).toBeVisible();
    await expect(element(by.text('Limrun Expo Test App'))).toBeVisible();
    await device.takeScreenshot('limrun-detox-home');

    await element(by.id(selectors.incrementButton)).tap();
    await element(by.id(selectors.incrementButton)).tap();
    await element(by.id(selectors.decrementButton)).tap();
    await waitFor(element(by.id(selectors.counterValue)))
      .toHaveText('1')
      .withTimeout(5000);
    await device.takeScreenshot('limrun-detox-counter');

    await element(by.id(selectors.nameInput)).tap();
    await element(by.id(selectors.nameInput)).typeText('Limrun');
    await element(by.id(selectors.nameInput)).tapReturnKey();
    await waitFor(element(by.id(selectors.greetingMessage)))
      .toHaveText('Hello, Limrun!')
      .withTimeout(5000);
    await device.takeScreenshot('limrun-detox-greeting');

    await element(by.id(selectors.openDetailButton)).tap();
    await waitFor(element(by.id(selectors.detailScreen)))
      .toBeVisible()
      .withTimeout(5000);
    await element(by.id(selectors.automationSwitch)).tap();
    await element(by.id(selectors.completeTaskButton)).tap();
    await waitFor(element(by.id(selectors.successMessage)))
      .toBeVisible()
      .withTimeout(5000);

    await device.takeScreenshot('limrun-detox-success');
  });
});
