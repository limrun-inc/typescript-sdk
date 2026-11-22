import { Args, Flags } from '@oclif/core';
import { randomUUID } from 'node:crypto';
import { BaseCommand } from '../base-command';
import { whoAmI } from '../lib/backend';
import { readConfig } from '../lib/config';

export default class Feedback extends BaseCommand {
  static summary = 'Send product feedback or open a support ticket';
  static examples = [
    '<%= config.bin %> feedback "The login link expired" --kind ticket --email me@example.com',
  ];
  static args = {
    message: Args.string({ required: true, description: 'Text to share with Limrun support.' }),
  };
  static flags = {
    'api-key': BaseCommand.baseFlags['api-key'],
    json: BaseCommand.baseFlags.json,
    quiet: BaseCommand.baseFlags.quiet,
    kind: Flags.string({ options: ['feedback', 'ticket'], default: 'feedback' }),
    subject: Flags.string({ description: 'Short summary. Defaults to the start of the message.' }),
    guest: Flags.boolean({ description: 'Submit outside your organization, even when signed in.' }),
    email: Flags.string({
      description: 'Mailbox for guest follow-up. Reply to the confirmation email to verify it.',
    }),
    'request-id': Flags.string({ description: 'UUID to reuse when retrying the same submission.' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Feedback);
    this.setParsedFlags(flags);
    const config = readConfig();
    const message = args.message.trim();
    const subject = flags.subject ?? Array.from(message).slice(0, 100).join('');
    const requestId = flags['request-id'] ?? randomUUID();
    const headers = { 'Idempotency-Key': requestId };
    let id: string | null;
    let followUp: string;
    if (!flags.guest && (flags['api-key'] || config.apiKey)) {
      if (flags.email)
        this.error('Use --guest with --email, or omit --email to submit to your organization.');
      const org = await whoAmI(this.client);
      const ticket = await this.client.post<{ id: string }>(
        `/v1/organizations/${encodeURIComponent(org)}/support_tickets`,
        {
          body: { kind: flags.kind, subject, message },
          headers,
        },
      );
      id = ticket.id;
      followUp = 'Follow up in the console under Support.';
    } else {
      let res: Response;
      try {
        res = await fetch(new URL('/feedback', config.apiEndpoint), {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: flags.kind, subject, message, email: flags.email, source: 'cli' }),
        });
      } catch {
        this.error(`Could not confirm submission. Retry with --request-id ${requestId}.`);
      }
      if (!res.ok)
        this.error(`Guest support returned HTTP ${res.status}. Retry with --request-id ${requestId}.`);
      id = res.headers.get('X-Limrun-Ticket-ID');
      followUp =
        flags.email ?
          'Reply to the verification email for follow-up.'
        : 'Submitted anonymously without a reply address.';
    }
    this.outputResult(
      { id, requestId, followUp },
      id ? `Submitted ${id}. ${followUp}` : 'Feedback accepted without a ticket reference.',
    );
  }
}
