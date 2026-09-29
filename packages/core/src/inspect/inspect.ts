import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitMaybe } from '../git/exec.js';
import type { ChangeCounts, InProgressOperation, RepoState, Worktree, WorktreeDetails } from './types.js';

/** Resolves a path inside a repo to the canonical (realpath) top level of its work tree. */
export async function repoRoot(path: string): Promise<string> {
  return canonical(await git(path, ['rev-parse', '--show-toplevel']));
}

export function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export async function currentBranch(repo: string): Promise<string | null> {
  return gitMaybe(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
}

export async function changeCounts(repo: string): Promise<ChangeCounts> {
  const out = await git(repo, ['status', '--porcelain=v1', '-z']);
  const fields = out.split('\0').filter((f) => f.length > 0);
  let uncommitted = 0;
  let untracked = 0;
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]!;
    const xy = entry.slice(0, 2);
    if (xy === '??') untracked++;
    else if (xy !== '!!') uncommitted++;
    // Renames and copies carry the original path as an extra NUL-separated field.
    if (xy[0] === 'R' || xy[0] === 'C') i++;
  }
  return { uncommitted, untracked };
}

export async function upstreamOf(repo: string, branch = 'HEAD'): Promise<string | null> {
  const ref = branch === 'HEAD' ? '@{upstream}' : `${branch}@{upstream}`;
  return gitMaybe(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', ref]);
}

export async function inProgressOperation(repo: string): Promise<InProgressOperation> {
  const gitDir = await git(repo, ['rev-parse', '--absolute-git-dir']);
  const has = (name: string) => existsSync(join(gitDir, name));
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
  if (has('MERGE_HEAD')) return 'merge';
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (has('REVERT_HEAD')) return 'revert';
  if (has('BISECT_LOG')) return 'bisect';
  return 'none';
}

export async function listWorktrees(repo: string): Promise<Worktree[]> {
  const out = await git(repo, ['worktree', 'list', '--porcelain']);
  const worktrees: Worktree[] = [];
  for (const block of out.split('\n\n')) {
    const lines = block.split('\n').filter(Boolean);
    const pathLine = lines.find((l) => l.startsWith('worktree '));
    if (!pathLine) continue;
    const branchLine = lines.find((l) => l.startsWith('branch '));
    worktrees.push({
      path: canonical(pathLine.slice('worktree '.length)),
      branch: branchLine ? branchLine.slice('branch '.length).replace(/^refs\/heads\//, '') : null,
      isMain: worktrees.length === 0,
      locked: lines.some((l) => l === 'locked' || l.startsWith('locked ')),
      prunable: lines.some((l) => l === 'prunable' || l.startsWith('prunable ')),
    });
  }
  return worktrees;
}

export async function worktreeDetails(repo: string, worktree: Worktree): Promise<WorktreeDetails> {
  const counts =
    worktree.prunable || !existsSync(worktree.path)
      ? { uncommitted: 0, untracked: 0 }
      : await changeCounts(worktree.path);
  const unpushed = worktree.branch
    ? Number(
        (await gitMaybe(repo, ['rev-list', '--count', `refs/heads/${worktree.branch}`, '--not', '--remotes'])) ?? 0,
      )
    : 0;
  return { ...worktree, ...counts, unpushed };
}

export async function inspect(path: string): Promise<RepoState> {
  const root = await repoRoot(path);
  const [branch, counts, upstream, inProgress, worktrees] = await Promise.all([
    currentBranch(root),
    changeCounts(root),
    upstreamOf(root),
    inProgressOperation(root),
    listWorktrees(root),
  ]);
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const lr = await gitMaybe(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
    if (lr) [ahead, behind] = lr.split(/\s+/).map(Number) as [number, number];
  }
  return { path: root, branch, upstream, ahead, behind, inProgress, worktrees, ...counts };
}
