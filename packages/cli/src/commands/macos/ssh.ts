import { Args, Flags } from '@oclif/core';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BaseCommand } from '../../base-command';

const SSH_DISCONNECTED = 'SSH tunnel disconnected. Run lim macos ssh again to reconnect.';

export default class MacosSsh extends BaseCommand {
  static summary = 'Open an SSH tunnel to a macOS instance';
  static description =
    'Turn on SSH inside the macOS guest, authorize your public key, and forward a local port to it until you press Ctrl-C. Then connect with ssh -p <port> limrun@localhost from another terminal, or point scp, rsync or your editor at it. Without --public-key, the first of ~/.ssh/id_ed25519.pub, id_ecdsa.pub and id_rsa.pub is used, or a key is created in ~/.lim/ssh.';
  static examples = [
    '<%= config.bin %> macos ssh 8080',
    '<%= config.bin %> macos ssh 2222 --public-key ~/.ssh/work.pub',
  ];

  static args = {
    port: Args.integer({ description: 'Local port to listen on.', default: 2222, min: 1, max: 65535 }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'macOS instance ID. Defaults to the last created macOS instance.' }),
    'public-key': Flags.string({ description: 'OpenSSH public key file to authorize.' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MacosSsh);
    this.setParsedFlags(flags);
    const { publicKey, identity } = this.loadPublicKey(flags['public-key']);

    await this.withAuth(async () => {
      const { id, client } = await this.resolveMacosClient(flags.id);
      const access = await client.enableSsh(publicKey);
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

  /** The key to authorize, and the private key ssh needs -i for when it is not a default one. */
  private loadPublicKey(file: string | undefined): { publicKey: string; identity?: string } {
    if (file) {
      const resolved = file.replace(/^~(?=$|\/)/, os.homedir());
      return {
        publicKey: fs.readFileSync(resolved, 'utf8').trim(),
        identity: resolved.replace(/\.pub$/, ''),
      };
    }
    for (const name of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
      const candidate = path.join(os.homedir(), '.ssh', `${name}.pub`);
      if (fs.existsSync(candidate)) return { publicKey: fs.readFileSync(candidate, 'utf8').trim() };
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
    return { publicKey: fs.readFileSync(`${key}.pub`, 'utf8').trim(), identity: key };
  }
}
