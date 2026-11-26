import { Args, Flags } from '@oclif/core';
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BaseCommand } from '../../base-command';
import { probePortOpen } from '../../lib/rbe-session';

const SSH_DISCONNECTED = 'SSH tunnel disconnected. Run lim macos ssh again to reconnect.';
/** How long a detached tunnel gets to start listening before the command gives up on it. */
const DETACHED_READY_MS = 30_000;

export default class MacosSsh extends BaseCommand {
  static summary = 'Open an SSH tunnel to a macOS instance';
  static description =
    'Turn on SSH inside the macOS guest, authorize your public key, and forward a local port to it. The forward runs in the background and the command returns once it listens; stop it with kill <pid>. With --no-detach it runs in the foreground until you press Ctrl-C. Then connect with ssh -p <port> limrun@localhost, or point scp, rsync or your editor at it. Without --public-key, the first of ~/.ssh/id_ed25519.pub, id_ecdsa.pub and id_rsa.pub is used, or a key is created in ~/.lim/ssh.';
  static examples = [
    '<%= config.bin %> macos ssh 8080',
    '<%= config.bin %> macos ssh 2222 --public-key ~/.ssh/work.pub',
    '<%= config.bin %> macos ssh 2222 --no-detach',
  ];

  static args = {
    port: Args.integer({ description: 'Local port to listen on.', default: 2222, min: 1, max: 65535 }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'macOS instance ID. Defaults to the last created macOS instance.' }),
    'public-key': Flags.string({ description: 'OpenSSH public key file to authorize.' }),
    detach: Flags.boolean({
      description:
        'Run the forward in a background process and return once it listens. Use --no-detach to stay in the foreground.',
      default: true,
      allowNo: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MacosSsh);
    this.setParsedFlags(flags);
    const { publicKey, publicKeyFile, identity } = this.loadPublicKey(flags['public-key']);

    await this.withAuth(async () => {
      const { id, client } = await this.resolveMacosClient(flags.id);
      const access = await client.enableSsh(publicKey);
      if (flags.detach) {
        const command = `ssh -p ${args.port}${identity ? ` -i ${identity}` : ''} ${access.user}@localhost`;
        // The child authorizes the key again, which is harmless, and owns the forward from then on.
        const { pid, logPath } = await this.startDetached(id, args.port, publicKeyFile, flags);
        if (this.isJsonEnabled()) {
          this.outputJson({ id, user: access.user, port: args.port, command, pid, logPath });
        } else {
          this.info(
            `Forwarding localhost:${args.port} to SSH on ${id} in the background (PID ${pid}). Stop it with kill ${pid}.`,
          );
          this.output(command);
        }
        return;
      }
      const tunnel = await client.startPortForward(args.port, access.port, { logLevel: 'none' });
      const command = `ssh -p ${args.port}${identity ? ` -i ${identity}` : ''} ${access.user}@localhost`;
      try {
        // A forward that is already down never reports a change, so it would wait on a dead port.
        if (tunnel.getConnectionState() === 'disconnected') throw new Error(SSH_DISCONNECTED);
        if (this.isJsonEnabled()) {
          this.outputJson({ id, user: access.user, port: args.port, command });
        } else {
          this.info(`Forwarding localhost:${args.port} to SSH on ${id}. Press Ctrl-C to stop.`);
          this.output(command);
        }
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            unsubscribe();
            process.off('SIGINT', stop);
            process.off('SIGTERM', stop);
          };
          const stop = () => {
            cleanup();
            resolve();
          };
          const unsubscribe = tunnel.onConnectionStateChange((state) => {
            if (state === 'reconnecting') this.info('SSH tunnel reconnecting...');
            if (state === 'disconnected') {
              cleanup();
              reject(new Error(SSH_DISCONNECTED));
            }
          });
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
        });
      } finally {
        tunnel.close();
      }
    });
  }

  /**
   * startDetached runs this command with --no-detach in a background process that outlives this
   * one, with its output in ~/.lim/ssh, and returns once the forward accepts connections.
   */
  private async startDetached(
    id: string,
    port: number,
    publicKeyFile: string,
    flags: Record<string, unknown>,
  ): Promise<{ pid: number; logPath: string }> {
    const directory = path.join(os.homedir(), '.lim', 'ssh');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const logPath = path.join(directory, `${id}-${port}.log`);
    const childArgs = [
      process.argv[1]!,
      'macos',
      'ssh',
      String(port),
      '--no-detach',
      '--id',
      id,
      '--public-key',
      publicKeyFile,
    ];
    if (typeof flags['api-key'] === 'string') childArgs.push('--api-key', flags['api-key']);
    const logFd = fs.openSync(logPath, 'w', 0o600);
    const child = spawn(process.execPath, childArgs, { detached: true, stdio: ['ignore', logFd, logFd] });
    fs.closeSync(logFd);
    child.unref();
    if (child.pid === undefined) throw new Error('Failed to start the background SSH tunnel.');
    const pid = child.pid;
    let exited: number | null | undefined;
    child.once('exit', (code) => (exited = code));
    const deadline = Date.now() + DETACHED_READY_MS;
    while (exited === undefined && Date.now() < deadline) {
      if (await probePortOpen(port)) return { pid, logPath };
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (exited === undefined) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
    const tail = fs.readFileSync(logPath, 'utf8').trim().split('\n').slice(-10).join('\n');
    throw new Error(
      `The background SSH tunnel ${
        exited === undefined ? 'did not start listening in time' : `exited during startup (code ${exited})`
      }.` + `${tail ? `\n${tail}` : ''}\nSee ${logPath} for details, or run with --no-detach.`,
    );
  }

  /** The key to authorize, its file, and the private key ssh needs -i for when it is not a default one. */
  private loadPublicKey(file: string | undefined): {
    publicKey: string;
    publicKeyFile: string;
    identity?: string;
  } {
    if (file) {
      const resolved = file.replace(/^~(?=$|\/)/, os.homedir());
      return {
        publicKey: fs.readFileSync(resolved, 'utf8').trim(),
        publicKeyFile: resolved,
        identity: resolved.replace(/\.pub$/, ''),
      };
    }
    for (const name of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
      const candidate = path.join(os.homedir(), '.ssh', `${name}.pub`);
      if (fs.existsSync(candidate))
        return { publicKey: fs.readFileSync(candidate, 'utf8').trim(), publicKeyFile: candidate };
    }
    const directory = path.join(os.homedir(), '.lim', 'ssh');
    const key = path.join(directory, 'id_ed25519');
    if (!fs.existsSync(`${key}.pub`)) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'lim macos', '-f', key], {
        stdio: 'ignore',
      });
      this.info(`Created an SSH key at ${key}.`);
    }
    return {
      publicKey: fs.readFileSync(`${key}.pub`, 'utf8').trim(),
      publicKeyFile: `${key}.pub`,
      identity: key,
    };
  }
}
