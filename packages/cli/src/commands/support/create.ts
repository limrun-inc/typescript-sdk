import { createHash } from 'node:crypto';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';

function ticketIdempotencyKey(body: {
  kind: string;
  subject: string;
  message: string;
  ccEmails?: string[];
}): string {
  const hash = createHash('sha256').update(JSON.stringify(body)).digest();
  // Encode the first 128 bits as a UUIDv8 for the support API.
  hash[6] = (hash.readUInt8(6) & 0x0f) | 0x80;
  hash[8] = (hash.readUInt8(8) & 0x3f) | 0x80;
  return [
    hash.toString('hex', 0, 4),
    hash.toString('hex', 4, 6),
    hash.toString('hex', 6, 8),
    hash.toString('hex', 8, 10),
    hash.toString('hex', 10, 16),
  ].join('-');
}

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
    cc: Flags.string({
      description: 'Email address to notify when support replies. Repeat for multiple recipients.',
      multiple: true,
    }),
    'idempotency-key': Flags.string({
      description: 'UUID for this event. Defaults to a hash of the ticket payload.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SupportCreate);
    this.setParsedFlags(flags);
    const ccEmails = flags.cc?.map((address) => address.trim());
    const body = {
      kind: 'ticket',
      subject: flags.subject,
      message: flags.message,
      ccEmails: ccEmails && [...new Set(ccEmails)].sort(),
    };
    const key = flags['idempotency-key'] ?? ticketIdempotencyKey(body);
    await this.withAuth(async () => {
      const ticket = await this.client.post<{ id: string }>(
        `/v1/organizations/${encodeURIComponent(flags.org)}/support_tickets`,
        {
          body,
          headers: { 'Idempotency-Key': key },
        },
      );
      this.outputResult(ticket, ticket.id);
    });
  }
}
