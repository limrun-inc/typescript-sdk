import type { AdbShellResult } from './instance-client';

export interface AndroidBillingPrice {
  formattedPrice: string;
  priceAmountMicros: number;
  priceCurrencyCode: string;
}

export interface AndroidBillingPricingPhase extends AndroidBillingPrice {
  billingPeriod: string;
  /** 1 = recurring, 2 = a fixed number of cycles, 3 = one period. */
  recurrenceMode: 1 | 2 | 3;
  billingCycleCount?: number;
}

export interface AndroidBillingSubscriptionOffer {
  basePlanId: string;
  offerId?: string;
  offerTags?: string[];
  pricingPhases: AndroidBillingPricingPhase[];
}

export type AndroidBillingProduct = {
  productId: string;
  title: string;
  name?: string;
  description?: string;
} & (
  | { type: 'inapp'; oneTimePurchaseOffer: AndroidBillingPrice }
  | { type: 'subs'; subscriptionOffers: AndroidBillingSubscriptionOffer[] }
);

/** Local catalog consumed by Companion through the app's normal BillingClient. */
export interface AndroidBillingCatalog {
  version: 1;
  products: AndroidBillingProduct[];
}

export type AndroidBillingOutcome = 'approved' | 'pending' | 'declined' | 'canceled';
export type AndroidBillingAction = 'approve' | 'reject' | 'cancel-renewal' | 'renew' | 'expire' | 'refund';

export interface AndroidBillingSandboxStatus {
  environment: 'limrun-local-sandbox';
  packageName: string;
  enabled: boolean;
  productIds: string[];
  nextOutcome: AndroidBillingOutcome;
  /** Public RSA test key. These purchases cannot be verified with Google's servers. */
  publicKey: string;
  purchases: Array<{
    productId: string;
    type: 'inapp' | 'subs';
    purchaseToken: string;
    state: 'pending' | 'purchased';
    acknowledged: boolean;
    autoRenewing: boolean;
    renewals: number;
  }>;
}

export interface AndroidBillingSandbox {
  /** Enable local billing for this package and reset previous simulated purchases. Maximum 64 KiB. */
  setConfig(packageName: string, catalog: AndroidBillingCatalog): Promise<void>;
  /** Remove the catalog and simulated purchases, restoring the regular Play backend. */
  clearConfig(packageName: string): Promise<void>;
  /** Clear purchases and queued outcomes while keeping the catalog. */
  reset(packageName: string): Promise<void>;
  status(packageName: string): Promise<AndroidBillingSandboxStatus>;
  /** Choose the outcome of the next confirmed checkout. Canceling the sheet does not consume it. */
  setNextOutcome(packageName: string, outcome: AndroidBillingOutcome): Promise<void>;
  /** Renew advances one billing period manually. Canceled or completed finite subscriptions expire. */
  transition(packageName: string, productId: string, action: AndroidBillingAction): Promise<void>;
}

/** Uses the existing authenticated instance shell transport. No Google account or merchant setup is required. */
export function createAndroidBillingSandbox(
  adbShell: (command: string, args: string[]) => Promise<AdbShellResult>,
): AndroidBillingSandbox {
  const call = async (method: string, packageName: string, extras: string[] = []): Promise<string> => {
    if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)) {
      throw new Error('Invalid Android package name');
    }
    const result = await adbShell('content', [
      'call',
      '--uri',
      'content://com.android.vending.billing.sandbox',
      '--method',
      method,
      '--arg',
      packageName,
      ...extras.flatMap((extra) => ['--extra', extra]),
    ]);
    if (result.truncated) throw new Error('Billing sandbox response was truncated');
    if (
      result.exitCode !== 0 ||
      !/\bok=true[,}\]]/.test(result.stdout) ||
      /\bok=false[,}\]]/.test(result.stdout)
    ) {
      throw new Error(
        `Billing sandbox ${method} failed: ${
          result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`
        }. Use an Android image with billing sandbox support.`,
      );
    }
    return result.stdout;
  };

  return {
    async setConfig(packageName, catalog) {
      const json = Buffer.from(JSON.stringify(catalog), 'utf8');
      if (json.length > 65536) throw new Error('Billing catalog exceeds 64 KiB');
      await call('set', packageName, [`config:s:${json.toString('base64')}`]);
    },
    async clearConfig(packageName) {
      await call('clear', packageName);
    },
    async reset(packageName) {
      await call('reset', packageName);
    },
    async status(packageName) {
      const output = await call('status', packageName);
      const data = /\bdata=([A-Za-z0-9+/]+=*)(?=[,}\]])/.exec(output)?.[1];
      if (!data) throw new Error('Billing sandbox returned no status data');
      const status = JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as AndroidBillingSandboxStatus;
      if (status.environment !== 'limrun-local-sandbox' || status.packageName !== packageName) {
        throw new Error('Billing sandbox returned an unexpected environment or package');
      }
      return status;
    },
    async setNextOutcome(packageName, outcome) {
      if (!['approved', 'pending', 'declined', 'canceled'].includes(outcome))
        throw new Error('Invalid billing outcome');
      await call('next', packageName, [`outcome:s:${outcome}`]);
    },
    async transition(packageName, productId, action) {
      if (!['approve', 'reject', 'cancel-renewal', 'renew', 'expire', 'refund'].includes(action)) {
        throw new Error('Invalid billing action');
      }
      if (!productId || /[\r\n\x00]/.test(productId)) throw new Error('Invalid product ID');
      await call(action, packageName, [`product:s:${productId}`]);
    },
  };
}
