import { randomUUID } from 'node:crypto';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class SupportCreate extends BaseCommand {
  static summary = 'Open a support ticket for an organization';
  static examples = [
    '<%= config.bin %> support create --org org_... --subject "Release build failed" --message "Build 1842 failed during signing."',
  ];
  static flags = {
    ...BaseCommand.readOnlyFlags,
    org: Flags.string({ description: 'Organization TypeID (org_...).', required: true }),
    subject: Flags.string({ description: 'Ticket subject.', required: true }),
    message: Flags.string({ description: 'Message for Limrun support.', required: true }),
    'idempotency-key': Flags.string({ description: 'UUID to reuse for every delivery of the same event.' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SupportCreate);
    this.setParsedFlags(flags);
    const key = flags['idempotency-key'] ?? randomUUID();
    await this.withAuth(async () => {
      const ticket = await this.client.post<{ id: string }>(
        `/v1/organizations/${encodeURIComponent(flags.org)}/support_tickets`,
        {
          body: { kind: 'ticket', subject: flags.subject, message: flags.message },
          headers: { 'Idempotency-Key': key },
        },
      );
      this.outputResult(ticket, ticket.id);
    });
  }
}
