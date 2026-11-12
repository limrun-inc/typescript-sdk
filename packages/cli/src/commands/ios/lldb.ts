import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { dwarfFiles, remoteDwarfName } from '../../lib/dsym';
import { getIosInstanceClient } from '../../lib/instance-client-factory';

type LldbResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export default class IosLldb extends BaseCommand {
  static summary = 'Debug an app on a running iOS instance with LLDB';
  static description =
    'Run LLDB next to the simulator, attached to an app by bundle ID or pid, and pass it the arguments after `--`. ' +
    'Without `--batch`, the session stays open and reads LLDB commands from standard input until the input ends or you `quit`. ' +
    'The app must be running and built for debugging: Xcode debug builds carry the `get-task-allow` entitlement LLDB needs. ' +
    'Use --dsym when the debug symbols live in a separate .dSYM. A simulator runs one LLDB session at a time.';
  static examples = [
    '<%= config.bin %> ios lldb --bundle-id com.example.app -- --batch -o "bt all"',
    '<%= config.bin %> ios lldb --bundle-id com.example.app --dsym ./MyApp.app.dSYM -- --batch -o "breakpoint set -f ContentView.swift -l 42" -o "continue" -o "frame variable"',
    'printf "bt\\nframe variable\\n" | <%= config.bin %> ios lldb --bundle-id com.example.app',
    '<%= config.bin %> ios lldb --bundle-id com.example.app',
  ];

  static strict = false;

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
    'bundle-id': Flags.string({
      description: 'Attach to the running app with this bundle ID.',
      exclusive: ['pid'],
    }),
    pid: Flags.integer({
      description: 'Attach to this process ID inside the simulator.',
      exclusive: ['bundle-id'],
    }),
    dsym: Flags.string({
      description:
        'A .dSYM bundle, or a DWARF file from one, to upload and load into the session. Repeat for several.',
      multiple: true,
    }),
  };

  async run(): Promise<void> {
    const parsed = await this.parse(IosLldb as any);
    const flags = parsed.flags as Record<string, any>;
    // The parser moves flag-like tokens ahead of their values, which would scramble `-o "bt"`
    // pairs, so LLDB's arguments are taken as typed after `--`.
    const separator = this.argv.indexOf('--');
    const rawArgs = separator === -1 ? [] : this.argv.slice(separator + 1);
    this.setParsedFlags(flags);

    const symbolFiles = ((flags.dsym as string[] | undefined) ?? []).flatMap((entry) => {
      try {
        return dwarfFiles(entry);
      } catch (err) {
        this.error((err as Error).message);
      }
    });

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);

      try {
        // Symbols load right after LLDB attaches, ahead of the caller's own commands.
        const symbolArgs: string[] = [];
        for (const [index, file] of symbolFiles.entries()) {
          const remotePath = await client.pushFile(file, remoteDwarfName(file, index));
          symbolArgs.push('-o', `target symbols add "${remotePath}"`);
        }

        // A batch run ends by itself. Anything else is a session that reads standard input.
        const interactive = !flags.json && !rawArgs.includes('--batch') && !rawArgs.includes('-b');
        const session = client.lldb([...symbolArgs, ...rawArgs], {
          ...(flags['bundle-id'] !== undefined && { bundleId: flags['bundle-id'] }),
          ...(flags.pid !== undefined && { pid: flags.pid }),
          keepStdinOpen: interactive,
        });

        const forwardInput = (chunk: Buffer) => session.write(chunk);
        const endInput = () => session.end();
        const interrupt = () => session.stop();
        if (interactive) {
          process.stdin.on('data', forwardInput);
          process.stdin.once('end', endInput);
          process.once('SIGINT', interrupt);
        }

        try {
          if (!flags.json) {
            session.on('stdout', (chunk: Buffer) => process.stdout.write(chunk));
            session.on('stderr', (chunk: Buffer) => process.stderr.write(chunk));
          }
          const result = (await session.wait()) as LldbResult;
          if (flags.json) {
            this.outputJson(result);
          }
          if (result.code !== 0) this.exit(result.code);
        } finally {
          if (interactive) {
            process.stdin.off('data', forwardInput);
            process.stdin.off('end', endInput);
            process.off('SIGINT', interrupt);
            // An open standard input would keep the command alive after LLDB has exited.
            process.stdin.pause();
          }
        }
      } finally {
        disconnect();
      }
    });
  }
}
