import { ux } from '@oclif/core';

/**
 * Spinner + checkmark progress reporting on stderr, shared across commands so
 * they all look the same (e.g. `lim run`, `lim xcode rbe`). Renders a live
 * spinner with an optional tail of streamed log lines on a TTY, and prints a
 * green ✔ / red ✖ line on completion. All output is suppressed when the owning
 * command is in --json/--quiet mode (via the injected `suppressed` predicate),
 * and falls back to no-op animation when stderr is not a TTY.
 */

const SPINNER_FRAMES =
  process.platform === 'win32' ? ['-', '\\', '|', '/'] : ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SUCCESS_ICON = process.platform === 'win32' ? '√' : '✔';
const FAILURE_ICON = process.platform === 'win32' ? '×' : '✖';
const DEFAULT_TAIL_LINES = 10;

type ProgressState = {
  frame: number;
  logLines: string[];
  message: string;
  renderedRows: number;
  timer?: NodeJS.Timeout;
};

export class ProgressReporter {
  private progress?: ProgressState;
  private readonly tailLines: number;

  constructor(
    private readonly suppressed: () => boolean,
    opts: { tailLines?: number } = {},
  ) {
    this.tailLines = opts.tailLines ?? DEFAULT_TAIL_LINES;
  }

  /** Print a standalone green ✔ line (no spinner). */
  success(message: string): void {
    if (this.suppressed()) {
      return;
    }
    process.stderr.write(`${ux.colorize('green', SUCCESS_ICON)} ${message}\n`);
  }

  /** Run `fn` under a spinner, resolving to a ✔ (or ✖ on throw). */
  async withProgress<T>(message: string, fn: () => Promise<T>, successMessage?: string): Promise<T> {
    this.start(message);
    try {
      const result = await fn();
      this.stop('success', successMessage);
      return result;
    } catch (err) {
      this.stop('failure');
      throw err;
    }
  }

  start(message: string): void {
    if (this.suppressed()) {
      return;
    }
    this.progress = { frame: 0, logLines: [], message, renderedRows: 0 };
    if (process.stderr.isTTY) {
      this.progress.timer = setInterval(() => this.render(), process.platform === 'win32' ? 500 : 100);
      this.progress.timer.unref();
      this.render();
    }
  }

  stop(result: 'success' | 'failure' = 'success', message?: string): void {
    if (this.suppressed() || !this.progress) {
      return;
    }
    const progress = this.progress;
    if (progress.timer) {
      clearInterval(progress.timer);
    }
    this.progress = undefined;
    this.clear(progress);
    const icon = result === 'success' ? ux.colorize('green', SUCCESS_ICON) : ux.colorize('red', FAILURE_ICON);
    process.stderr.write(`${icon} ${message ?? progress.message}\n`);
  }

  /** Replace the spinner message in place; the render loop picks it up. */
  update(message: string): void {
    if (this.suppressed() || !this.progress) {
      return;
    }
    this.progress.message = message;
    this.render();
  }

  appendLog(chunk: string): void {
    if (this.suppressed() || !this.progress) {
      return;
    }
    const lines = String(chunk)
      .replace(/\r/g, '\n')
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    if (lines.length === 0) {
      return;
    }
    this.progress.logLines.push(...lines);
    this.progress.logLines = this.progress.logLines.slice(-this.tailLines);
    this.render();
  }

  private render(): void {
    if (!this.progress || !process.stderr.isTTY) {
      return;
    }
    const frame = SPINNER_FRAMES[this.progress.frame % SPINNER_FRAMES.length]!;
    this.progress.frame += 1;
    const lines = [
      progressLine(`${ux.colorize('magenta', frame)} ${this.progress.message}`),
      ...this.progress.logLines.map((line) => ux.colorize('dim', `  ${truncateTerminalLine(line, 2)}`)),
    ];
    this.clear(this.progress);
    this.progress.renderedRows = lines.length;
    process.stderr.write(lines.join('\n'));
  }

  private clear(progress: ProgressState): void {
    if (!process.stderr.isTTY) {
      return;
    }
    process.stderr.clearLine(0);
    process.stderr.cursorTo(0);
    for (let i = 1; i < progress.renderedRows; i += 1) {
      process.stderr.moveCursor(0, -1);
      process.stderr.clearLine(0);
      process.stderr.cursorTo(0);
    }
  }
}

function progressLine(line: string): string {
  const width = process.stderr.columns;
  if (!width || line.length < width - 1) {
    return line;
  }
  return `${line.slice(0, Math.max(0, width - 4))}...`;
}

function truncateTerminalLine(line: string, indent = 0): string {
  const width = process.stderr.columns;
  const max = width ? width - indent - 1 : undefined;
  if (!max || line.length < max) {
    return line;
  }
  return `${line.slice(0, Math.max(0, max - 3))}...`;
}
