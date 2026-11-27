import { LimrunError } from './core/error';

/** The macOS attach route returned 404; the Xcode instance may be older or may be gone. */
export class MacOSAttachUnavailableError extends LimrunError {
  constructor(operation: string) {
    super(
      `${operation} is unavailable; this Xcode instance may predate macOS instance support or no longer exist.`,
    );
    this.name = 'MacOSAttachUnavailableError';
  }
}
