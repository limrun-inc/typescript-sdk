import { APIPromise } from '../core/api-promise';
import { APIResource } from '../core/resource';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';
import { uuid4 } from '../internal/utils/uuid';

export interface SupportTicketCreateParams {
  kind: 'ticket' | 'feedback';
  subject: string;
  message: string;
  ccEmails?: string[];
}

export interface SupportTicket {
  id: string;
  organizationId: string;
  kind: string;
  status: string;
  subject: string;
  createdAt: string;
}

export class SupportTickets extends APIResource {
  /** Opens a ticket. Pass the same idempotencyKey when retrying the same event. */
  create(
    organizationId: string,
    body: SupportTicketCreateParams,
    options?: RequestOptions,
  ): APIPromise<SupportTicket> {
    return this._client.post(path`/v1/organizations/${organizationId}/support_tickets`, {
      ...options,
      body,
      headers: buildHeaders([{ 'Idempotency-Key': options?.idempotencyKey ?? uuid4() }, options?.headers]),
    });
  }

  /** Replaces the recipients of future support notifications. Pass an empty array to clear them. */
  setCC(
    organizationId: string,
    ticketId: string,
    ccEmails: string[],
    options?: RequestOptions,
  ): APIPromise<void> {
    return this._client.patch(path`/v1/organizations/${organizationId}/support_tickets/${ticketId}`, {
      ...options,
      body: { ccEmails },
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }
}
