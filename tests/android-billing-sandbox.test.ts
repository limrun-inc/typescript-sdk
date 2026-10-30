import { createAndroidBillingSandbox, type AndroidBillingCatalog } from '../src/android-billing-sandbox';

const catalog: AndroidBillingCatalog = {
  version: 1,
  products: [
    {
      productId: 'coins',
      title: 'Coins',
      type: 'inapp',
      oneTimePurchaseOffer: { formattedPrice: '$1', priceAmountMicros: 1000000, priceCurrencyCode: 'USD' },
    },
  ],
};

const success = { stdout: 'Result: Bundle[{ok=true}]', stderr: '', exitCode: 0, truncated: false };

describe('Android billing sandbox transport', () => {
  const shell = jest.fn();
  const billing = createAndroidBillingSandbox(shell);
  beforeEach(() => {
    shell.mockReset();
    shell.mockResolvedValue(success);
  });

  it('sends a per-package catalog as one base64 argument', async () => {
    await billing.setConfig('com.example.app', catalog);
    expect(shell).toHaveBeenCalledWith('content', [
      'call',
      '--uri',
      'content://com.android.vending.billing.sandbox',
      '--method',
      'set',
      '--arg',
      'com.example.app',
      '--extra',
      `config:s:${Buffer.from(JSON.stringify(catalog)).toString('base64')}`,
    ]);
  });

  it.each(['../other', 'com.app; touch /tmp/pwn', '', 'com.app\nnext'])(
    'rejects invalid package %p without a command',
    async (name) => {
      await expect(billing.reset(name)).rejects.toThrow('package name');
      expect(shell).not.toHaveBeenCalled();
    },
  );

  it('rejects oversized catalogs before opening the shell', async () => {
    await expect(
      billing.setConfig('com.example.app', {
        ...catalog,
        products: [{ ...catalog.products[0]!, description: 'x'.repeat(65536) }],
      }),
    ).rejects.toThrow('64 KiB');
    expect(shell).not.toHaveBeenCalled();
  });

  it.each([
    { ...success, exitCode: 1, stderr: 'Permission denied' },
    { ...success, stdout: 'No content provider found' },
    { ...success, stdout: 'Result: Bundle[{ok=false, error=Product is not owned}]' },
    { ...success, truncated: true },
  ])('does not report success for a failed control call', async (result) => {
    shell.mockResolvedValue(result);
    await expect(billing.transition('com.example.app', 'pro', 'renew')).rejects.toThrow();
  });

  it('decodes status and rejects a different target or environment', async () => {
    const status = {
      environment: 'limrun-local-sandbox',
      packageName: 'com.example.app',
      enabled: true,
      purchases: [],
    };
    const encode = (value: unknown) =>
      `Result: Bundle[{data=${Buffer.from(JSON.stringify(value)).toString('base64')}, ok=true}]`;
    shell.mockResolvedValue({ ...success, stdout: encode(status) });
    expect(await billing.status('com.example.app')).toEqual(status);
    shell.mockResolvedValue({ ...success, stdout: encode({ ...status, packageName: 'com.other.app' }) });
    await expect(billing.status('com.example.app')).rejects.toThrow('unexpected environment or package');
  });

  it('keeps lifecycle controls scoped and passes product text as one argument', async () => {
    await billing.setNextOutcome('com.example.app', 'pending');
    await billing.transition('com.example.app', "product';$(anything)", 'approve');
    await billing.clearConfig('com.example.app');
    expect(shell.mock.calls[0]![1]).toContain('outcome:s:pending');
    expect(shell.mock.calls[1]![1]).toContain("product:s:product';$(anything)");
    expect(shell.mock.calls[2]![1]).toContain('clear');
  });
});
