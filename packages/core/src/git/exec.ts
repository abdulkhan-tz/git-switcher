import { execFile } from 'node:child_process';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: GitResult,
  ) {
    const detail = (result.stderr || result.stdout).trim();
    super(`git ${args.join(' ')} failed (exit ${result.code})${detail ? `: ${detail}` : ''}`);
    this.name = 'GitError';
  }
}

// Git is always invoked with an argument array, never a shell string: branch names are user input.
// LC_ALL=C keeps messages parseable; GIT_TERMINAL_PROMPT=0 stops a credential prompt from hanging a run.
export function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      // Never let one of our commands kick off git's automatic housekeeping: `gc --auto` packs refs,
      // and packing breaks any checkout whose branch a case-insensitive disk has folded.
      ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args],
      {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** Runs git and returns stdout with the trailing newline removed; throws GitError on non-zero exit. */
export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.code !== 0) throw new GitError(args, result);
  return result.stdout.replace(/\n$/, '');
}

/** Runs git and returns trimmed stdout, or null on non-zero exit (for "does X exist" probes). */
export async function gitMaybe(cwd: string, args: readonly string[]): Promise<string | null> {
  const result = await runGit(cwd, args);
  return result.code === 0 ? result.stdout.trim() : null;
}
