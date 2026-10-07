import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
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

/**
 * On a case-insensitive disk (the macOS default) a loose ref directory such as `refs/heads/Feature/`
 * swallows a new `feature/x` ref, which then reads back as `Feature/x`. Returns the on-disk ref
 * directories that would do that to `branch`, under local heads and the remote's tracking refs.
 */
function caseConflictingDirs(commonDir: string, branch: string, remote: string): string[] {
  const dirs = branch.split('/').slice(0, -1);
  const conflicts: string[] = [];
  for (const base of ['refs/heads', `refs/remotes/${remote}`]) {
    let abs = join(commonDir, base);
    let rel = base;
    for (const part of dirs) {
      let entries: string[];
      try {
        entries = existsSync(abs) ? readdirSync(abs) : [];
      } catch {
        break;
      }
      const hit = entries.find((e) => e.toLowerCase() === part.toLowerCase());
      if (!hit) break;
      if (hit !== part) {
        conflicts.push(`${rel}/${hit}/`);
        break;
      }
      abs = join(abs, hit);
      rel = `${rel}/${hit}`;
    }
  }
  return conflicts;
}

/** A checkout whose HEAD names a branch that git stored with different case (an earlier fold). */
export interface FoldedHead {
  path: string;
  head: string;
  stored: string;
}

/**
 * Packing refs removes a folding directory, but it also makes a folded HEAD unresolvable: HEAD says
 * `feature/x`, the packed ref is `Feature/x`, and packed lookups are case-sensitive. So every
 * checkout on a folded branch has to be known before packing.
 */
export async function foldedHeads(repo: string): Promise<FoldedHead[]> {
  const exact = new Set(await refNames(repo, 'refs/heads/'));
  const byLower = new Map([...exact].map((n) => [n.toLowerCase(), n]));
  return (await listWorktrees(repo)).flatMap((w) => {
    if (!w.branch || exact.has(w.branch)) return [];
    const stored = byLower.get(w.branch.toLowerCase());
    return stored ? [{ path: w.path, head: w.branch, stored }] : [];
  });
}

/**
 * Fixes every checkout whose branch git stored with different case (HEAD `feature/x`, ref
 * `Feature/x`) — including ones a pack has already broken, where HEAD resolves to nothing and git
 * claims there are no commits. HEAD holds the name the branch was created with, so that is the name
 * kept. Packs first (removing the folding directory, so the renamed refs keep their case), then
 * renames them all back to back. Returns what it repaired.
 */
export async function repairCase(repoPath: string): Promise<FoldedHead[]> {
  const repo = await repoRoot(repoPath).catch(() => canonical(repoPath));
  const folded = await foldedHeads(repo);
  if (folded.length === 0) return [];
  const exact = await refNames(repo, 'refs/heads/');
  for (const f of folded) {
    const variants = exact.filter((n) => n.toLowerCase() === f.head.toLowerCase());
    if (variants.length !== 1) {
      throw new Error(`${f.path} is on "${f.head}", stored ambiguously as ${variants.join(', ')} — rename one by hand`);
    }
  }
  await git(repo, ['pack-refs', '--all']);
  for (const f of folded) await git(repo, ['branch', '-m', f.stored, f.head]);
  return folded;
}

/** `git pack-refs --all` (what `git gc` does), then confirm no folding directory is left. */
async function packRefs(repo: string, commonDir: string, branch: string, remote: string, step: Step): Promise<void> {
  await git(repo, ['pack-refs', '--all']);
  const left = caseConflictingDirs(commonDir, branch, remote);
  if (left.length > 0) {
    throw new StepFailure(step, `${left.join(', ')} would store "${branch}" with the wrong case, and packing refs did not clear it`);
  }
}

/** The remote's own branch → SHA list (tracking refs cannot be trusted for case on this disk). */
async function remoteHeads(repo: string, remote: string): Promise<Map<string, string>> {
  const out = await git(repo, ['ls-remote', '--heads', remote]);
  return new Map(
    out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, ref] = line.split('\t') as [string, string];
        return [ref.replace(/^refs\/heads\//, ''), sha] as const;
      }),
  );
}

/** Listed (not looked-up) tracking refs whose name matches `branch` ignoring case, with their SHAs. */
async function trackingEntries(repo: string, remote: string, branch: string): Promise<Map<string, string>> {
  const prefix = `refs/remotes/${remote}/`;
  const out = await git(repo, ['for-each-ref', '--format=%(refname) %(objectname)', prefix]);
  const lower = branch.toLowerCase();
  const found = new Map<string, string>();
  for (const line of out.split('\n').filter(Boolean)) {
    const [ref, sha] = line.split(' ') as [string, string];
    const name = ref.slice(prefix.length);
    if (name.toLowerCase() === lower) found.set(name, sha);
  }
  return found;
}

/**
 * A remote with both `Feature/` and `feature/` branches makes every fetch fold one family into the
 * other on this disk: the fresh value lands under the wrong name and the exact name goes stale.
 * A lookup still finds the folded loose file, so git looks fine — until the next pack-refs lets the
 * stale entry win. Fix it from the listing: pack, drop the wrongly-cased copies, write the exact
 * ref at the remote's SHA, pack again.
 */
async function trackingNeedsRepair(repo: string, remote: string, branch: string, sha: string): Promise<boolean> {
  const entries = await trackingEntries(repo, remote, branch);
  return entries.get(branch) !== sha || entries.size > 1;
}

async function repairTracking(repo: string, remote: string, branch: string, sha: string, step: Step): Promise<void> {
  const ref = `refs/remotes/${remote}/${branch}`;
  await git(repo, ['pack-refs', '--all']);
  for (const name of (await trackingEntries(repo, remote, branch)).keys()) {
    if (name !== branch) await git(repo, ['update-ref', '-d', `refs/remotes/${remote}/${name}`]);
  }
  if ((await runGit(repo, ['cat-file', '-e', `${sha}^{commit}`])).code === 0) await git(repo, ['update-ref', ref, sha]);
  else await git(repo, ['fetch', remote, `+refs/heads/${branch}:${ref}`]);
  await git(repo, ['pack-refs', '--all']);
  const after = await trackingEntries(repo, remote, branch);
  if (after.get(branch) !== sha || after.size > 1) {
    throw new StepFailure(step, `could not repair ${remote}/${branch}: tracking refs are ${[...after].map(([n, v]) => `${n}@${v.slice(0, 7)}`).join(', ')}`);
  }
}

async function storedAs(repo: string, branch: string): Promise<string | null> {
  const lower = branch.toLowerCase();
  const names = await refNames(repo, 'refs/heads/');
  return names.includes(branch) ? branch : (names.find((n) => n.toLowerCase() === lower) ?? null);
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
    let commonDir = await git(repo, ['rev-parse', '--git-common-dir']);
    if (!isAbsolute(commonDir)) commonDir = join(repo, commonDir);
    // Keep the branch name's exact case on a case-insensitive disk (see caseConflictingDirs). First
    // repair any checkout an earlier fold left wrongly cased — packing is only safe without them.
    let repairedNote = '';
    try {
      const repaired = await repairCase(repo);
      if (repaired.length) {
        repairedNote = `; repaired ${repaired.length} branch(es) stored with the wrong case: ${repaired.map((f) => `${f.stored} → ${f.head}`).join(', ')}`;
      }
    } catch (e) {
      throw new StepFailure('preflight', (e as Error).message);
    }
    const conflicts = caseConflictingDirs(commonDir, branch, remote);
    let packNote = '';
    if (conflicts.length > 0) {
      await packRefs(repo, commonDir, branch, remote, 'preflight');
      packNote = `; packed refs so ${conflicts.join(', ')} cannot change the case of "${branch}"`;
    }
    emit('preflight', 'ok', `on ${from ?? '(detached HEAD)'}${repairedNote}${packNote}`);

    // 2. Fetch
    emit('fetch', 'start');
    let remoteBranches: string[] = [];
    let remoteSha: string | undefined;
    const remotes = (await git(repo, ['remote'])).split('\n').filter(Boolean);
    const hasRemote = remotes.includes(remote);
    if (hasRemote) {
      await git(repo, ['fetch', '--prune', remote]);
      const heads = await remoteHeads(repo, remote);
      remoteBranches = [...heads.keys()];
      remoteSha = heads.get(branch);
      let note = '';
      if (remoteSha && (await trackingNeedsRepair(repo, remote, branch, remoteSha))) {
        await repairTracking(repo, remote, branch, remoteSha, 'fetch');
        note = `; repaired ${remote}/${branch}, which a fetch had stored with the wrong case`;
      }
      emit('fetch', 'ok', `fetched ${remote}${note}`);
    } else if (remotes.length === 0) {
      emit('fetch', 'skip', 'repo has no remotes');
    } else {
      throw new StepFailure('fetch', `remote "${remote}" not found (have: ${remotes.join(', ')})`);
    }

    // 3. Resolve
    emit('resolve', 'start');
    await validateBranchName(repo, branch);
    const local = await refNames(repo, 'refs/heads/');

    const lower = branch.toLowerCase();
    const localVariants = local.filter((b) => b !== branch && b.toLowerCase() === lower);
    const remoteVariants = remoteBranches.filter((b) => b !== branch && b.toLowerCase() === lower).map((b) => `${remote}/${b}`);
    // One local branch stored with the wrong case (an earlier fold), nothing ambiguous on the
    // remote: rename it to exactly what was typed. When the remote has that exact name there is no
    // doubt about the intended case, so it just happens; a local-only branch asks first.
    let renameFrom: string | undefined;
    if (localVariants.length === 1 && !local.includes(branch) && remoteVariants.length === 0) {
      const stored = localVariants[0]!;
      if (!remoteBranches.includes(branch) && !(await prompter({ kind: 'fixBranchCase', repo, branch, stored }))) {
        throw new Cancelled(`local branch is stored as "${stored}"; renaming it to "${branch}" was declined`);
      }
      renameFrom = stored;
    } else if (localVariants.length + remoteVariants.length > 0) {
      throw new StepFailure(
        'resolve',
        `branch names differ only in case from "${branch}": ${[...localVariants, ...remoteVariants].join(', ')} — rename or delete one first (macOS folds case in refs)`,
      );
    }
    let checkout: Checkout;
    if (renameFrom) {
      checkout = from === branch || from === renameFrom ? { mode: 'current' } : { mode: 'local' };
      emit('resolve', 'ok', `will rename ${renameFrom} → ${branch}`);
    } else if (from === branch) {
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

    // A branch stored with the wrong case that no checkout is on (checked-out ones were repaired in
    // preflight): pack so the new name keeps its case, then rename.
    if (renameFrom) {
      emit('refs', 'start');
      if (caseConflictingDirs(commonDir, branch, remote).length > 0) await packRefs(repo, commonDir, branch, remote, 'refs');
      await git(repo, ['branch', '-m', renameFrom, branch]);
      emit('refs', 'ok', `renamed ${renameFrom} → ${branch}`);
    }

    // 5/6. Stash
    emit('stash', 'start');
    const counts = await changeCounts(repo);
    if (counts.uncommitted + counts.untracked > 0) {
      const message = `git-tidy: ${from ?? '(detached)'} → ${branch} @ ${now().toISOString()} #${runId}`;
      await git(repo, ['stash', 'push', '--include-untracked', '-m', message]);
      if (!(await findStash(repo, `#${runId}`))) throw new StepFailure('stash', 'git stash reported success but no stash was created');
      stashMessage = message;
      emit('stash', 'ok', `stashed ${counts.uncommitted} changed, ${counts.untracked} untracked`);
    } else {
      emit('stash', 'skip', 'working tree clean');
    }

    // 7. Checkout
    emit('checkout', 'start');
    if ((checkout.mode === 'track' || checkout.mode === 'create') && caseConflictingDirs(commonDir, branch, remote).length > 0) {
      await packRefs(repo, commonDir, branch, remote, 'checkout');
    }
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

    // The branch must now exist under exactly the name typed — unless it is still unborn (a repo with
    // no commits yet), where HEAD names it but no ref exists to check.
    const unborn = checkout.mode === 'current' && (await runGit(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code !== 0;
    const stored = unborn ? branch : await storedAs(repo, branch);
    if (stored !== branch) {
      throw new StepFailure('checkout', `git stored the branch as "${stored ?? '(missing)'}" instead of "${branch}"`);
    }

    // 8. Pull
    emit('pull', 'start');
    const upstream = await upstreamOf(repo);
    if (upstream) {
      // The fetch step already brought the remote up to date (and repaired this branch's tracking ref),
      // so fast-forward from it; `git pull` would fetch again and could fold the ref once more.
      const before = await git(repo, ['rev-parse', 'HEAD']);
      if (upstream.startsWith(`${remote}/`)) await git(repo, ['merge', '--ff-only', '@{upstream}']);
      else await git(repo, ['pull', '--ff-only']);
      const after = await git(repo, ['rev-parse', 'HEAD']);
      emit('pull', 'ok', before === after ? `up to date with ${upstream}` : `fast-forwarded to ${upstream} (${after.slice(0, 7)})`);
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
