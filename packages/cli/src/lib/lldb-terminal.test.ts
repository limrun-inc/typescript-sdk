import { LldbOutputLines } from './lldb-terminal';

describe('LldbOutputLines', () => {
  it('drops the echo of each command once and keeps the output around it', () => {
    const lines = new LldbOutputLines();
    lines.sent('bt 1');
    expect(lines.push('(lldb) bt 1\n* thread #1\n  frame #0: main\n')).toEqual([
      '* thread #1',
      '  frame #0: main',
    ]);
    // The same text again is output, not an echo: nothing was sent since.
    expect(lines.push('(lldb) bt 1\n')).toEqual(['(lldb) bt 1']);
  });

  it('joins a line split across chunks and cuts the terminal start-up noise', () => {
    const lines = new LldbOutputLines();
    expect(lines.push('Cannot read termcap database;\nusing dumb termi')).toEqual([]);
    expect(lines.push('nal settings.\nProcess 42 stop')).toEqual([]);
    expect(lines.push('ped\n')).toEqual(['Process 42 stopped']);
    expect(lines.push('no newline')).toEqual([]);
    expect(lines.flush()).toEqual(['no newline']);
  });
});
