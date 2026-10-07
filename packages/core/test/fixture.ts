import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Prompter, PromptRequest } from '../src/index.js';

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export interface Fixture {
  dir: string;
  remote: string;
  /** The working clone under test. */
  work: string;
  /** A second clone used to push commits "from someone else". */
  other: string;
  write(repo: string, file: string, content: string): void;
  read(repo: string, file: string): string;
  exists(repo: string, file: string): boolean;
  commit(repo: string, file: string, content: string, message?: string): void;
  pushNewBranch(branch: string, file?: string): void;
}

/** bare remote with `main` and `feature`, plus two clones on `main`. */
export function makeFixture(): Fixture {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'git-tidy-')));
  const remote = join(dir, 'remote.git');
  sh(dir, 'init', '--bare', '-b', 'main', remote);
  const seed = join(dir, 'seed');
  sh(dir, 'clone', '-q', remote, seed);
  const fx: Fixture = {
    dir,
    remote,
    work: join(dir, 'work'),
    other: join(dir, 'other'),
    write: (repo, file, content) => writeFileSync(join(repo, file), content),
    read: (repo, file) => readFileSync(join(repo, file), 'utf8'),
    exists: (repo, file) => existsSync(join(repo, file)),
    commit(repo, file, content, message = `edit ${file}`) {
      fx.write(repo, file, content);
      sh(repo, 'add', file);
      sh(repo, 'commit', '-q', '-m', message);
    },
    pushNewBranch(branch, file = `${branch.replace(/\W/g, '_')}.txt`) {
      // Detached + explicit refspec, and packed refs on the bare remote, so names keep their exact
      // case even on a case-insensitive disk — the way GitHub stores them.
      sh(seed, 'switch', '-q', '--detach', 'origin/main');
      fx.commit(seed, file, branch);
      sh(seed, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
      sh(remote, 'pack-refs', '--all');
      sh(seed, 'switch', '-q', 'main');
    },
  };
  fx.commit(seed, 'shared.txt', 'base\n');
  sh(seed, 'push', '-q', 'origin', 'main');
  fx.pushNewBranch('feature', 'feature.txt');
  sh(dir, 'clone', '-q', remote, fx.work);
  sh(dir, 'clone', '-q', remote, fx.other);
  return fx;
}

/** A prompter that answers from a queue and records what it was asked. */
export function scripted(...answers: boolean[]): Prompter & { asked: PromptRequest[] } {
  const asked: PromptRequest[] = [];
  const fn = (async (req: PromptRequest) => {
    asked.push(req);
    const next = answers.shift();
    if (next === undefined) throw new Error(`unexpected prompt: ${req.kind}`);
    return next;
  }) as Prompter & { asked: PromptRequest[] };
  fn.asked = asked;
  return fn;
}
