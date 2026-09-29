import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export interface Io {
  stdin: Readable;
  stdout: Writable;
  cwd: string;
  color: boolean;
}

export interface Out {
  line(text?: string): void;
  green(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  dim(s: string): string;
  bold(s: string): string;
}

export function makeOut(io: Io): Out {
  const wrap = (code: number) => (s: string) => (io.color ? `\x1b[${code}m${s}\x1b[0m` : s);
  return {
    line: (text = '') => void io.stdout.write(text + '\n'),
    green: wrap(32),
    red: wrap(31),
    yellow: wrap(33),
    dim: wrap(2),
    bold: wrap(1),
  };
}

/** Reads answers line by line; buffered, so piped input works as well as a TTY. EOF answers "". */
export function lineReader(io: Io): (question: string) => Promise<string> {
  let iterator: AsyncIterator<string> | undefined;
  return async (question) => {
    io.stdout.write(question);
    iterator ??= createInterface({ input: io.stdin, terminal: false })[Symbol.asyncIterator]();
    const next = await iterator.next();
    const answer = next.done ? '' : next.value.trim();
    // A TTY echoes what was typed; piped input does not, so end the prompt line ourselves.
    if (!(io.stdin as { isTTY?: boolean }).isTTY) io.stdout.write(answer + '\n');
    return answer;
  };
}
