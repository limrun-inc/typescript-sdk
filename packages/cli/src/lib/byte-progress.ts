import { SingleBar } from 'cli-progress';
import { formatBytes } from './bytes';

/**
 * Byte-transfer progress reporting on stderr, shared by commands that move
 * files (asset push/pull, sync basis download). On a TTY it renders a live
 * progress bar; on non-interactive output (CI, pipes) it prints at most four
 * milestone lines (25/50/75/100%) so logs stay short. Everything is a no-op
 * when the owning command is in --json/--quiet mode, so callers don't need to
 * branch. Output starts lazily on the first update so commands that end up
 * transferring nothing (e.g. push short-circuits on an md5 match) stay silent.
 */
export class ByteProgressBar {
  private bar?: SingleBar;
  private milestonesPrinted = 0;

  constructor(
    private readonly label: string,
    private readonly suppressed: boolean,
  ) {}

  update(transferredBytes: number, totalBytes: number): void {
    if (this.suppressed || totalBytes <= 0) {
      return;
    }
    if (!process.stderr.isTTY) {
      const milestone = Math.min(4, Math.floor((transferredBytes / totalBytes) * 4));
      if (milestone > this.milestonesPrinted) {
        this.milestonesPrinted = milestone;
        process.stderr.write(
          `${this.label} ${milestone * 25}% (${formatBytes(transferredBytes)} / ${formatBytes(
            totalBytes,
          )})\n`,
        );
      }
      return;
    }
    if (!this.bar) {
      this.bar = new SingleBar({
        format: `${this.label} [{bar}] {percentage}% | {transferred} / {size}`,
        stream: process.stderr,
        hideCursor: true,
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
      });
      this.bar.start(totalBytes, 0, {
        transferred: formatBytes(0),
        size: formatBytes(totalBytes),
      });
    }
    this.bar.update(transferredBytes, {
      transferred: formatBytes(transferredBytes),
      size: formatBytes(totalBytes),
    });
  }

  stop(): void {
    this.bar?.stop();
    this.bar = undefined;
    this.milestonesPrinted = 0;
  }
}
