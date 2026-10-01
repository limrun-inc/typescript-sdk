import { Flags } from '@oclif/core';
import { beginMCPLogin, completeMCPLogin } from '../lib/mcp-login';
import { loadMCPConnection } from '../lib/mcp-connection';
import { BaseCommand } from '../base-command';
import { readConfig } from '../lib/config';
import { login } from '../lib/auth';

const VERSION = require('../../package.json').version;
const loginFlags = { ...BaseCommand.baseFlags };
delete (loginFlags as Partial<typeof loginFlags>).json;

export default class Login extends BaseCommand {
  static summary = 'Log in to Limrun';
  static description =
    'Open your browser to authenticate with Limrun, or use --mcp to pair this workspace with an existing MCP connection. Complete an approved pairing with --complete <sessionId>.';
  static examples = ['<%= config.bin %> login'];
  static flags = {
    ...loginFlags,
    mcp: Flags.boolean({
      description: 'Start pairing with the authenticated Limrun MCP connection.',
      exclusive: ['complete'],
    }),
    complete: Flags.string({
      description: 'Collect an approved MCP pairing in this workspace.',
      exclusive: ['mcp'],
    }),
    'api-endpoint': Flags.string({
      description: 'API endpoint returned by get-cli-auth-context.',
      dependsOn: ['mcp'],
    }),
    'auth-endpoint': Flags.string({
      description: 'Authentication endpoint returned by get-cli-auth-context.',
      dependsOn: ['mcp'],
    }),
    'console-endpoint': Flags.string({
      description: 'Console endpoint returned by get-cli-auth-context.',
      dependsOn: ['mcp'],
    }),
    'organization-id': Flags.string({
      description: 'Organization returned by get-cli-auth-context.',
      dependsOn: ['mcp'],
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Login);
    this.setParsedFlags(flags);
    if (flags.mcp) {
      if (
        !flags['api-endpoint'] ||
        !flags['auth-endpoint'] ||
        !flags['console-endpoint'] ||
        !flags['organization-id']
      )
        this.error(
          'MCP pairing requires --api-endpoint, --auth-endpoint, --console-endpoint, and --organization-id from get-cli-auth-context.',
        );
      this.log(
        JSON.stringify(
          await beginMCPLogin(
            {
              apiEndpoint: flags['api-endpoint'],
              authEndpoint: flags['auth-endpoint'],
              consoleEndpoint: flags['console-endpoint'],
              organizationId: flags['organization-id'],
            },
            VERSION,
          ),
        ),
      );
      return;
    }
    if (flags.complete) {
      this.log(JSON.stringify(await completeMCPLogin(flags.complete)));
      return;
    }
    if (loadMCPConnection())
      this.error(
        'This workspace uses MCP authentication. Pair again with lim login --mcp instead of browser login.',
      );
    const config = readConfig();
    this.info('Authenticating with Limrun...');
    await login(config.apiEndpoint, config.consoleEndpoint, VERSION, {
      log: (message) => this.info(message),
    });
    this.info('Authentication successful.');
  }
}
