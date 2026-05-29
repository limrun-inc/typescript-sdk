import { NotFoundError } from '../core/error';

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
  return new Error(message);
}
