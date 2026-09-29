import { randomBytes } from 'node:crypto';
import { git, gitMaybe, GitError, runGit } from '../git/exec.js';
import {
  canonical,
  changeCounts,
  currentBranch,
  inProgressOperation,
  listWorktrees,
  repoRoot,
  upstreamOf,
  worktreeDetails,
} from '../inspect/inspect.js';
import type { Prompter, RunResult, Step, StepEvent, StepStatus, SwitchOptions } from './types.js';

class StepFailure extends Error {
  constructor(
    readonly step: Step,
    message: string,
  ) {
    super(message);
  }
}

class Cancelled extends Error {}

type Checkout =
  | { mode: 'current' }
  | { mode: 'local' }
  | { mode: 'track'; remoteRef: string }
  | { mode: 'create'; base: string };

export function newRunId(): string {
  return randomBytes(4).toString('hex');
}

/** Finds a stash entry by a marker in its message; returns e.g. `stash@{2}`. */
export async function findStash(repo: string, marker: string): Promise<string | null> {
  const out = await git(repo, ['stash', 'list', '--format=%gd%x00%gs']);
  for (const line of out.split('\n')) {
    const [ref, subject] = line.split('\0');
    if (ref && subject?.includes(marker)) return ref;
  }
  return null;
}

async function refNames(repo: string, prefix: string): Promise<string[]> {
  const out = await git(repo, ['for-each-ref', '--format=%(refname)', prefix]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((r) => r.slice(prefix.length))
    .filter((r) => r !== 'HEAD');
}

async function defaultBase(repo: string, remote: string, hasRemote: boolean): Promise<{ base: string; fallback: boolean }> {
  if (hasRemote) {
    const head = await gitMaybe(repo, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]);
    if (head) return { base: head, fallback: false };
    for (const name of ['main', 'master']) {
      if ((await runGit(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${name}`])).code === 0) {
        return { base: `${remote}/${name}`, fallback: false };
      }
    }
  }
  return { base: 'HEAD', fallback: true };
}

async function validateBranchName(repo: string, branch: string): Promise<void> {
  if (!branch || branch.startsWith('-')) throw new StepFailure('resolve', `"${branch}" is not a valid branch name`);
  const ok = await runGit(repo, ['check-ref-format', '--branch', branch]);
  if (ok.code !== 0) throw new StepFailure('resolve', `"${branch}" is not a valid branch name`);
}

/**
 * One switch run: stash → checkout → pull → pop, stopping at the first failure.
 * Nothing in the repo changes before every prompt has been answered.
 */
export async function switchBranch(
  repoPath: string,
  branch: string,
  opts: SwitchOptions,
  prompter: Prompter,
  onEvent?: (event: StepEvent) => void,
): Promise<RunResult> {
  const runId = opts.runId ?? newRunId();
  const now = opts.now ?? (() => new Date());
  const remote = opts.remote ?? 'origin';
  const events: StepEvent[] = [];
  const startedAt = now().toISOString();
  let repo = canonical(repoPath);
  let from: string | null = null;
  let current: Step = 'preflight';
  let stashMessage: string | undefined;

  const emit = (step: Step, status: StepStatus, message = '') => {
    if (status === 'start') current = step;
    const event: StepEvent = { runId, repo, step, status, message };
    events.push(event);
    onEvent?.(event);
  };

  const finish = async (partial: Partial<RunResult> & Pick<RunResult, 'outcome'>): Promise<RunResult> => {
    const result: RunResult = { runId, repo, from, to: branch, startedAt, finishedAt: now().toISOString(), events, ...partial };
    if (stashMessage) {
      result.stashMessage = stashMessage;
      const ref = await findStash(repo, `#${runId}`).catch(() => null);
      if (ref) result.stashRef = ref;
    }
    if (result.outcome === 'failed') result.recovery = await recoveryText(repo, result);
    return result;
  };

  try {
    // 1. Preflight
    emit('preflight', 'start');
    try {
      repo = await repoRoot(repoPath);
    } catch (e) {
      throw new StepFailure('preflight', `${repoPath} is not inside a git work tree`);
    }
    const op = await inProgressOperation(repo);
    if (op !== 'none') throw new StepFailure('preflight', `a ${op} is in progress; finish or abort it first`);
    from = await currentBranch(repo);
    await git(repo, ['worktree', 'prune']);
    emit('preflight', 'ok', `on ${from ?? '(detached HEAD)'}`);

    // 2. Fetch
    emit('fetch', 'start');
    const remotes = (await git(repo, ['remote'])).split('\n').filter(Boolean);
    const hasRemote = remotes.includes(remote);
    if (hasRemote) {
      await git(repo, ['fetch', '--prune', remote]);
      emit('fetch', 'ok', `fetched ${remote}`);
    } else if (remotes.length === 0) {
      emit('fetch', 'skip', 'repo has no remotes');
    } else {
      throw new StepFailure('fetch', `remote "${remote}" not found (have: ${remotes.join(', ')})`);
    }

    // 3. Resolve
    emit('resolve', 'start');
    await validateBranchName(repo, branch);
    const local = await refNames(repo, 'refs/heads/');
    const remoteBranches = hasRemote ? await refNames(repo, `refs/remotes/${remote}/`) : [];
    const lower = branch.toLowerCase();
    const caseVariants = [
      ...local.filter((b) => b !== branch && b.toLowerCase() === lower),
      ...remoteBranches.filter((b) => b !== branch && b.toLowerCase() === lower).map((b) => `${remote}/${b}`),
    ];
    if (caseVariants.length > 0) {
      throw new StepFailure(
        'resolve',
        `branch names differ only in case from "${branch}": ${caseVariants.join(', ')} — rename or delete one first (macOS folds case in refs)`,
      );
    }
    let checkout: Checkout;
    if (from === branch) {
      checkout = { mode: 'current' };
      emit('resolve', 'ok', 'already on this branch');
    } else if (local.includes(branch)) {
      checkout = { mode: 'local' };
      emit('resolve', 'ok', 'local branch');
    } else if (remoteBranches.includes(branch)) {
      checkout = { mode: 'track', remoteRef: `${remote}/${branch}` };
      emit('resolve', 'ok', `will track ${remote}/${branch}`);
    } else {
      const { base: fallbackBase, fallback } = await defaultBase(repo, remote, hasRemote);
      const base = opts.base ?? fallbackBase;
      const yes = await prompter({ kind: 'createBranch', repo, branch, base, baseIsFallback: !opts.base && fallback });
      if (!yes) throw new Cancelled(`branch "${branch}" not found; creation declined`);
      if ((await runGit(repo, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])).code !== 0) {
        throw new StepFailure('resolve', `base "${base}" does not exist`);
      }
      checkout = { mode: 'create', base };
      emit('resolve', 'ok', `will create from ${base}`);
    }

    // 4. Worktree conflict
    emit('worktree', 'start');
    const holder = (await listWorktrees(repo)).find((w) => w.branch === branch && w.path !== repo);
    if (holder) {
      if (holder.isMain) {
        throw new StepFailure(
          'worktree',
          `"${branch}" is checked out in the main checkout at ${holder.path}; the main checkout is never removed — switch it to another branch first`,
        );
      }
      const details = await worktreeDetails(repo, holder);
      if (!(await prompter({ kind: 'removeWorktree', repo, branch, worktree: details }))) {
        throw new Cancelled(`"${branch}" is checked out in worktree ${holder.path}; removal declined`);
      }
      const dirty = details.uncommitted + details.untracked > 0;
      if (dirty && !(await prompter({ kind: 'confirmDirtyWorktree', repo, branch, worktree: details }))) {
        throw new Cancelled(`worktree ${holder.path} has uncommitted changes; removal declined`);
      }
      const force = details.locked ? ['--force', '--force'] : dirty ? ['--force'] : [];
      await git(repo, ['worktree', 'remove', ...force, holder.path]);
      emit('worktree', 'ok', `removed worktree ${holder.path}`);
    } else {
      emit('worktree', 'skip', 'branch not checked out elsewhere');
    }

    // 5/6. Stash
    emit('stash', 'start');
    const counts = await changeCounts(repo);
    if (counts.uncommitted + counts.untracked > 0) {
      const message = `gsw: ${from ?? '(detached)'} → ${branch} @ ${now().toISOString()} #${runId}`;
      await git(repo, ['stash', 'push', '--include-untracked', '-m', message]);
      if (!(await findStash(repo, `#${runId}`))) throw new StepFailure('stash', 'git stash reported success but no stash was created');
      stashMessage = message;
      emit('stash', 'ok', `stashed ${counts.uncommitted} changed, ${counts.untracked} untracked`);
    } else {
      emit('stash', 'skip', 'working tree clean');
    }

    // 7. Checkout
    emit('checkout', 'start');
    switch (checkout.mode) {
      case 'current':
        emit('checkout', 'skip', 'already on this branch');
        break;
      case 'local':
        await git(repo, ['switch', branch]);
        emit('checkout', 'ok', `switched to ${branch}`);
        break;
      case 'track':
        await git(repo, ['switch', '-c', branch, '--track', checkout.remoteRef]);
        emit('checkout', 'ok', `created ${branch} tracking ${checkout.remoteRef}`);
        break;
      case 'create':
        await git(repo, ['switch', '--no-track', '-c', branch, checkout.base]);
        emit('checkout', 'ok', `created ${branch} from ${checkout.base}`);
        break;
    }

    // 8. Pull
    emit('pull', 'start');
    const upstream = await upstreamOf(repo);
    if (upstream) {
      await git(repo, ['pull', '--ff-only']);
      emit('pull', 'ok', `up to date with ${upstream}`);
    } else {
      emit('pull', 'skip', 'branch has no upstream');
    }

    // 9. Pop own stash
    emit('pop', 'start');
    if (stashMessage) {
      const ref = await findStash(repo, `#${runId}`);
      if (!ref) throw new StepFailure('pop', 'this run\'s stash is no longer in the stash list');
      const pop = await runGit(repo, ['stash', 'pop', ref]);
      if (pop.code !== 0) {
        const conflicted = (await git(repo, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
        const detail = (pop.stderr || pop.stdout).trim();
        emit('pop', 'fail', conflicted.length ? `conflicts in ${conflicted.length} file(s)` : detail);
        return finish({ outcome: 'failed', failedStep: 'pop', error: detail, conflictedFiles: conflicted });
      }
      emit('pop', 'ok', 'restored stashed changes');
    } else {
      emit('pop', 'skip', 'nothing was stashed');
    }

    return finish({ outcome: 'switched' });
  } catch (e) {
    if (e instanceof Cancelled) {
      emit(current, 'skip', e.message);
      return finish({ outcome: 'cancelled', error: e.message });
    }
    const step = e instanceof StepFailure ? e.step : current;
    const message = e instanceof Error ? e.message : String(e);
    emit(step, 'fail', message);
    return finish({ outcome: 'failed', failedStep: step, error: message });
  }
}

async function recoveryText(repo: string, result: RunResult): Promise<string> {
  const lines: string[] = [];
  const on = await currentBranch(repo).catch(() => null);
  lines.push(`Stopped at step "${result.failedStep}". The repo is on ${on ?? '(detached HEAD)'}; nothing was switched back.`);
  if (result.failedStep === 'pop' && result.conflictedFiles?.length) {
    lines.push(`Stash applied with conflicts in: ${result.conflictedFiles.join(', ')}`);
    lines.push('Resolve them, then `git stash drop ' + (result.stashRef ?? '<ref>') + '` once you are happy (git kept the stash).');
  } else if (result.stashRef) {
    lines.push(`Your changes are safe in ${result.stashRef} ("${result.stashMessage}").`);
    lines.push(`Restore them with: git stash pop ${result.stashRef}`);
  } else if (!result.stashMessage) {
    lines.push('No changes were stashed by this run.');
  }
  return lines.join('\n');
}

export { GitError };
