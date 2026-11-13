import { LimrunError } from './core/error';

/** The debug symbol route returned 404; the Xcode instance may be older or may be gone. */
export class SimulatorDebugSymbolsUnavailableError extends LimrunError {
  constructor(operation: string) {
    super(
      `${operation} is unavailable; this Xcode instance may predate debug symbol support or no longer exist.`,
    );
    this.name = 'SimulatorDebugSymbolsUnavailableError';
  }
}
