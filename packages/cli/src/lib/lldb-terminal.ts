import readline from 'readline';

/** LLDB prints this at start because the simulator has no terminal database for it to read. */
const TERMINAL_NOISE = /^(Cannot read termcap database;|using dumb terminal settings\.)$/;

/**
 * Splits LLDB output into the lines worth showing. LLDB reads its commands from a pipe, so it
 * echoes each one as `(lldb) <command>`. In a terminal session the user already sees what they
 * typed at the local prompt, so those echoes are dropped, once per command.
 */
export class LldbOutputLines {
  private partial = '';
  private echoes: string[] = [];

  /** Remember a command just sent, so its echo is not shown again. */
  sent(command: string): void {
    this.echoes.push(`(lldb) ${command}`);
  }

  /** Feed a chunk of output and get its complete lines back, without echoes and start-up noise. */
  push(chunk: Buffer | string): string[] {
    const lines = (this.partial + chunk.toString()).split('\n');
    this.partial = lines.pop() ?? '';
    return lines.filter((line) => !this.dropped(line));
  }

  /** The unfinished last line, once no more output will come. */
  flush(): string[] {
    const rest = this.partial;
    this.partial = '';
    return rest && !this.dropped(rest) ? [rest] : [];
  }

  private dropped(line: string): boolean {
    if (TERMINAL_NOISE.test(line)) return true;
    if (this.echoes[0] === line.trimEnd()) {
      this.echoes.shift();
      return true;
    }
    return false;
  }
}

type Session = {
  write(data: string): void;
  end(): void;
  stop(): void;
};

/**
 * Gives a live LLDB session a prompt. LLDB shows none of its own when it reads a pipe, which
 * left the terminal silent after the attach. Returns the output writers and a cleanup.
 */
export function startLldbTerminal(session: Session): {
  stdout: (chunk: Buffer) => void;
  stderr: (chunk: Buffer) => void;
  close: () => void;
} {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '(lldb) ' });
  const out = new LldbOutputLines();
  const err = new LldbOutputLines();
  let closed = false;

  const show = (stream: NodeJS.WriteStream, lines: string[]) => {
    if (lines.length === 0) return;
    // Output arrives while the prompt is on screen: clear it, print, and put it back.
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    stream.write(lines.join('\n') + '\n');
    if (!closed) rl.prompt(true);
  };

  rl.on('line', (line) => {
    out.sent(line);
    session.write(line + '\n');
    rl.prompt();
  });
  // Ctrl-D ends the input, which makes LLDB detach and exit. Ctrl-C ends the session at once.
  rl.on('close', () => {
    if (!closed) session.end();
  });
  rl.on('SIGINT', () => session.stop());
  rl.prompt();

  return {
    stdout: (chunk) => show(process.stdout, out.push(chunk)),
    stderr: (chunk) => show(process.stderr, err.push(chunk)),
    close: () => {
      closed = true;
      show(process.stdout, out.flush());
      show(process.stderr, err.flush());
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      rl.close();
    },
  };
}
