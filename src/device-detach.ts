import { LimrunError } from './core/error';

/** A detach route returned 404; the daemon may be older or the sandbox may be gone. */
export class DeviceDetachUnavailableError extends LimrunError {
  constructor(operation: string) {
    super(`${operation} is unavailable; this sandbox may predate detach support or no longer exist.`);
    this.name = 'DeviceDetachUnavailableError';
  }
}
