import { Args, Flags } from '@oclif/core';
import fs from 'node:fs/promises';
import type { AndroidBillingAction, AndroidBillingCatalog, AndroidBillingOutcome } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import { getAndroidInstanceClient } from '../../lib/instance-client-factory';

export default class AndroidBilling extends BaseCommand {
  static summary = 'Configure and control local Android purchase simulation';
  static description =
    "Use the app's normal Play Billing client with a local product catalog. No Google account, merchant setup, or screen lock is required. " +
    'Purchases use a public test key and cannot pass Google server verification. Requires an Android image with billing sandbox support. ' +
    'Set and reset erase simulated purchases. Clear removes the catalog and returns the app to the regular Play backend. ' +
    'Renew manually advances one subscription period; canceled subscriptions expire at that boundary.';
  static args = {
    action: Args.string({
      required: true,
      options: [
        'set',
        'clear',
        'status',
        'reset',
        'next',
        'approve',
        'reject',
        'cancel-renewal',
        'renew',
        'expire',
        'refund',
      ],
    }),
    package: Args.string({ required: true, description: 'Android application package name' }),
  };
  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'Android instance ID. Defaults to the last used Android instance.' }),
    config: Flags.string({ description: 'Path to a version 1 JSON catalog, required for set.' }),
    product: Flags.string({ description: 'Product ID, required for purchase lifecycle actions.' }),
    outcome: Flags.string({
      options: ['approved', 'pending', 'declined', 'canceled'],
      description: 'Next confirmed checkout outcome, required for next.',
    }),
  };
  static examples = [
    '<%= config.bin %> android billing set com.example.app --config billing.json --id <instance-ID>',
    '<%= config.bin %> android billing next com.example.app --outcome pending',
    '<%= config.bin %> android billing approve com.example.app --product coins',
    '<%= config.bin %> android billing renew com.example.app --product pro',
    '<%= config.bin %> android billing status com.example.app --json',
  ];

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AndroidBilling);
    this.setParsedFlags(flags);
    const action = args.action;
    const lifecycle = ['approve', 'reject', 'cancel-renewal', 'renew', 'expire', 'refund'].includes(action);
    if (action === 'set' && !flags.config) this.error('set requires --config');
    if (action === 'next' && !flags.outcome) this.error('next requires --outcome');
    if (lifecycle && !flags.product) this.error(`${action} requires --product`);
    if (flags.config && action !== 'set') this.error('--config is only valid with set');
    if (flags.outcome && action !== 'next') this.error('--outcome is only valid with next');
    if (flags.product && !lifecycle) this.error('--product is only valid with a purchase lifecycle action');
    const catalog =
      flags.config ?
        (JSON.parse(await fs.readFile(flags.config, 'utf8')) as AndroidBillingCatalog)
      : undefined;
    await this.withAuth(async () => {
      const { client, disconnect } = await getAndroidInstanceClient(
        this.client,
        this.resolveAndroidInstance(flags.id),
      );
      try {
        const billing = client.billing;
        if (action === 'set') await billing.setConfig(args.package, catalog!);
        else if (action === 'clear') await billing.clearConfig(args.package);
        else if (action === 'reset') await billing.reset(args.package);
        else if (action === 'next')
          await billing.setNextOutcome(args.package, flags.outcome as AndroidBillingOutcome);
        else if (lifecycle)
          await billing.transition(args.package, flags.product!, action as AndroidBillingAction);
        const status = await billing.status(args.package);
        if (flags.json) this.outputJson(status);
        else this.output(JSON.stringify(status, null, 2));
      } finally {
        disconnect();
      }
    });
  }
}
