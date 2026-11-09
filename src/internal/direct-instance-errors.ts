import { NotFoundError } from '../core/error';

/** Error thrown for non-2xx direct-instance responses, carrying the HTTP
 *  status and raw body so callers can match on them structurally instead of
 *  parsing the message. */
export type DirectInstanceHttpError = Error & { status: number; body: string };

export function directInstanceHttpError(
  operation: string,
  status: number,
  text: string,
  headers: Headers,
): Error {
  const message = `${operation} failed: ${status}${text ? ` ${text}` : ''}`;
  if (status === 404) {
    return new NotFoundError(404, { message }, undefined, headers);
  }
  return Object.assign(new Error(message), { status, body: text });
}

/**
 * The reason in a direct-instance error body: limulator answers JSON with
 * `message` (its framework's own errors carry `reason`), websocket-proxy plain text.
 */
export function directInstanceErrorReason(text: string): string {
  const trimmed = text.trim();
  try {
    const body = JSON.parse(trimmed) as { message?: string; reason?: string };
    return body.message || body.reason || trimmed;
  } catch {
    return trimmed;
  }
}

/** Narrow an unknown error to a direct-instance HTTP error with the given status. */
export function isDirectInstanceHttpError(err: unknown, status: number): err is DirectInstanceHttpError {
  return err instanceof Error && (err as Partial<DirectInstanceHttpError>).status === status;
}
