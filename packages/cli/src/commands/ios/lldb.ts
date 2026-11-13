import { SimulatorDebugSymbolsUnavailableError } from '@limrun/api';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { loadLastXcodeInstance } from '../../lib/config';
import { buildRunsOnSimulator, dwarfFiles, remoteDwarfName } from '../../lib/dsym';
import { envInstanceTarget } from '../../lib/set-instance';
import { getIosInstanceClient, resolveIosConnection } from '../../lib/instance-client-factory';
import { LldbOutputLines, startLldbTerminal } from '../../lib/lldb-terminal';

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
    'An app that `lim xcode build` installed gets its debug symbols automatically. For an app built elsewhere, use --dsym when the symbols live in a separate .dSYM. ' +
    'A simulator runs one LLDB session at a time.';
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

  /**
   * The debug symbols of an app that `lim xcode build` installed on this simulator. Such a build
   * keeps its debug info on the Xcode instance, so the instance uploads it to the simulator.
   * Returns nothing for an app that came from anywhere else. Debugging goes on without symbols
   * when this fails.
   */
  private async xcodeBuildSymbols(
    simulator: { id: string; apiUrl?: string },
    bundleId: string,
  ): Promise<string[]> {
    const target = envInstanceTarget('xcode') ?? loadLastXcodeInstance();
    if (!target) return [];
    let xcode;
    try {
      xcode = await this.resolveXcodeClient(target);
      if (!buildRunsOnSimulator(await xcode.getSimulator(), simulator, bundleId)) return [];
    } catch (err) {
      // The remembered Xcode instance is gone or unreachable, so it has no say in this session.
      this.debug(`skipping Xcode build symbols: ${(err as Error).message}`);
      return [];
    }
    try {
      this.logToStderr('Loading debug symbols from the Xcode build...');
      return (await xcode.syncSimulatorDebugSymbols()).paths;
    } catch (err) {
      // An Xcode instance from before this feature has nothing to offer, which is no news.
      if (!(err instanceof SimulatorDebugSymbolsUnavailableError)) {
        this.warn(`Debugging without symbols from the Xcode build: ${(err as Error).message}`);
      }
      return [];
    }
  }

  async run(): Promise<void> {
    const parsed = await this.parse(IosLldb as any);
    const flags = parsed.flags as Record<string, any>;
    // The parser moves flag-like tokens ahead of their values, which would scramble `-o "bt"`
    // pairs, so LLDB's arguments are taken as typed after `--`.
    const separator = this.argv.indexOf('--');
    const rawArgs = separator === -1 ? [] : this.argv.slice(separator + 1);
    if (separator === -1 && parsed.argv.length > 0) {
      this.error(`Pass LLDB arguments after \`--\`, for example: -- --batch -o "bt"`);
    }
    this.setParsedFlags(flags);
    if (flags.dsym && flags['bundle-id'] === undefined && flags.pid === undefined) {
      this.error('--dsym needs an app to load symbols for: pass --bundle-id or --pid');
    }

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
        const symbolPaths: string[] = [];
        for (const [index, file] of symbolFiles.entries()) {
          symbolPaths.push(await client.pushFile(file, remoteDwarfName(file, index)));
        }
        if (symbolFiles.length === 0 && flags['bundle-id'] !== undefined) {
          // The live URL, since the remembered instance may not carry one yet.
          const { apiUrl } = await resolveIosConnection(this.client, resolvedInstance);
          const simulator = { id: resolvedInstance.id, apiUrl };
          symbolPaths.push(...(await this.xcodeBuildSymbols(simulator, flags['bundle-id'])));
        }
        const symbolArgs = symbolPaths.flatMap((remotePath) => ['-o', `target symbols add "${remotePath}"`]);

        // A batch run ends by itself. Anything else is a session that reads standard input.
        // With --json a terminal has nowhere to show a prompt, so only piped input is read.
        const batch = rawArgs.includes('--batch') || rawArgs.includes('-b');
        const interactive = !batch && !(flags.json && process.stdin.isTTY);
        const session = client.lldb([...symbolArgs, ...rawArgs], {
          ...(flags['bundle-id'] !== undefined && { bundleId: flags['bundle-id'] }),
          ...(flags.pid !== undefined && { pid: flags.pid }),
          keepStdinOpen: interactive,
        });

        // At a terminal the session gets a prompt. Otherwise standard input is a script or a
        // stream from another program and is forwarded as it comes. The prompt needs the output
        // to be a terminal too, or its control codes would land in a file or a pipe.
        const atTerminal = process.stdin.isTTY && process.stdout.isTTY && !flags.json;
        const terminal = interactive && atTerminal ? startLldbTerminal(session) : undefined;
        const piped = interactive && !terminal;
        const forwardInput = (chunk: Buffer) => session.write(chunk);
        const endInput = () => session.end();
        const interrupt = () => session.stop();
        if (piped) {
          process.stdin.on('data', forwardInput);
          process.stdin.once('end', endInput);
          process.once('SIGINT', interrupt);
        }

        const noise = new LldbOutputLines();
        try {
          if (terminal) {
            session.on('stdout', terminal.stdout);
            session.on('stderr', terminal.stderr);
          } else if (!flags.json) {
            session.on('stdout', (chunk: Buffer) => process.stdout.write(chunk));
            // Standard error is small and line-shaped, so LLDB's start-up noise is cut from it.
            session.on('stderr', (chunk: Buffer) => {
              for (const line of noise.push(chunk)) process.stderr.write(line + '\n');
            });
          }
          const result = (await session.wait()) as LldbResult;
          for (const line of noise.flush()) process.stderr.write(line + '\n');
          if (flags.json) {
            this.outputJson(result);
          }
          if (result.code !== 0) this.exit(result.code);
        } finally {
          terminal?.close();
          if (piped) {
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
