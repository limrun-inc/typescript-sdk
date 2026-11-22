import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../base-command';
import { readConfig } from '../lib/config';
import { feedbackSender, sendFeedback } from '../lib/backend';
import { readStdin } from '../lib/stdin';

export default class Feedback extends BaseCommand {
  static summary = 'Send feedback to the Limrun team';
  static description =
    'Send a bug report, a missing feature, or anything confusing about Limrun straight to the team. ' +
    'Pass the message as an argument or pipe it on stdin. The CLI version and, when logged in, the ' +
    'organization go with it so the team can follow up.';
  static examples = [
    '<%= config.bin %> feedback "lim ios tap-element cannot find buttons inside a SwiftUI sheet"',
    'cat notes.md | <%= config.bin %> feedback',
    '<%= config.bin %> feedback --email dev@example.com "xcode build hangs at signing"',
  ];

  static args = {
    message: Args.string({ description: 'Feedback text. Read from stdin when omitted.' }),
  };

  static flags = {
    ...BaseCommand.readOnlyFlags,
    email: Flags.string({
      description: 'Address to reply to. Defaults to the logged-in user, if any.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Feedback);
    this.setParsedFlags(flags);

    let message = args.message;
    if (message === undefined && !process.stdin.isTTY) {
      message = (await readStdin()).toString('utf8');
    }
    message = message?.trim();
    if (!message) {
      this.error('Pass the feedback as an argument or on stdin, e.g. `lim feedback "..."`.');
    }

    const hasCredential = Boolean(flags['api-key'] || readConfig().apiKey);
    const sender = hasCredential ? await feedbackSender(this.client) : {};
    const email = flags.email ?? sender.emailAddress;
    const context = [`cli: ${this.config.userAgent}`];
    if (sender.organizationId) {
      context.push(`organization: ${sender.organizationId}`);
    }
    await sendFeedback(this.client, `${message}\n\n---\n${context.join('\n')}`, email);

    if (flags.json) {
      this.outputJson({ sent: true });
      return;
    }
    this.output('Thanks! Your feedback was sent to the Limrun team.');
  }
}
