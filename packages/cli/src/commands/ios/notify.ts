import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { runIosSimctl } from '../../lib/instance-client-factory';

const NOTIFYUTIL_FLAGS = { post: '-p', set: '-s', get: '-g' } as const;

export default class IosNotify extends BaseCommand {
  static summary = 'Post, set or read a Darwin notification on a running iOS instance';
  static description =
    "Run the simulator's `notifyutil`, for example to enroll Face ID and make the next scan match or fail. `post` is `notifyutil -p`, `set` is `-s` and `get` is `-g`. Same as `lim ios simctl -- spawn booted notifyutil ...`.";
  static examples = [
    '<%= config.bin %> ios notify set com.apple.BiometricKit.enrollmentChanged 1',
    '<%= config.bin %> ios notify post com.apple.BiometricKit.enrollmentChanged',
    '<%= config.bin %> ios notify post com.apple.BiometricKit_Sim.pearl.match',
    '<%= config.bin %> ios notify get com.apple.BiometricKit.enrollmentChanged --id <instance-ID>',
  ];

  static args = {
    action: Args.string({
      description: 'What to do with the notification',
      options: Object.keys(NOTIFYUTIL_FLAGS),
      required: true,
    }),
    name: Args.string({ description: 'Notification name', required: true }),
    state: Args.string({ description: 'State to set, for `set` only' }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosNotify);
    this.setParsedFlags(flags);

    const action = args.action as keyof typeof NOTIFYUTIL_FLAGS;
    if ((action === 'set') !== (args.state !== undefined)) {
      this.error('Pass a state for `set`, and only for `set`.');
    }
    const notifyArgs = [
      NOTIFYUTIL_FLAGS[action],
      args.name,
      ...(args.state === undefined ? [] : [args.state]),
    ];

    await this.withAuth(async () => {
      const result = await runIosSimctl(this.client, this.resolveIosInstance(flags.id), [
        'spawn',
        'booted',
        'notifyutil',
        ...notifyArgs,
      ]);
      if (flags.json) {
        this.outputJson(result);
      } else {
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
      }
      if (result.code !== 0) this.exit(result.code);
    });
  }
}
