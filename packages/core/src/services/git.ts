import { runGit } from '../git/exec.js';
import { expandHome } from './store.js';

export interface GitFile {
  /** Two-letter porcelain status: ` M` modified, `??` untracked, `A ` added, … */
  status: string;
  path: string;
}

export interface StashEntry {
  ref: string;
  message: string;
  files: string[];
}

/** The git state of the folder a service runs from. */
export interface ServiceGit {
  root: string;
  branch: string | null;
  head: string;
  files: GitFile[];
  stashes: StashEntry[];
  /** Files across all stash entries, counted once per entry. */
  stashFileCount: number;
}

export interface GitSummary {
  branch: string | null;
  dirty: number;
  stashes: number;
  stashFiles: number;
}

async function out(cwd: string, args: string[]): Promise<string | null> {
  const r = await runGit(cwd, args);
  return r.code === 0 ? r.stdout : null;
}

async function stashEntries(root: string): Promise<StashEntry[]> {
  const list = await out(root, ['stash', 'list', '--format=%gd%x09%s']);
  if (!list?.trim()) return [];
  return Promise.all(
    list
      .trim()
      .split('\n')
      .map(async (line): Promise<StashEntry> => {
        const [ref = '', ...rest] = line.split('\t');
        // --include-untracked also lists files a `stash -u` saved; older git rejects it
        const names = (await out(root, ['stash', 'show', '--include-untracked', '--name-only', ref])) ?? (await out(root, ['stash', 'show', '--name-only', ref])) ?? '';
        return { ref, message: rest.join('\t'), files: names.split('\n').filter(Boolean) };
      }),
  );
}

/** Uncommitted files and stashes for the repo containing `cwd`, or null if it is not inside one. */
export async function serviceGit(cwd: string): Promise<ServiceGit | null> {
  const dir = expandHome(cwd);
  const root = (await out(dir, ['rev-parse', '--show-toplevel']))?.trim();
  if (!root) return null;
  const [status, branch, head, stashes] = await Promise.all([
    out(root, ['status', '--porcelain=v1', '-uall', '--no-renames']),
    out(root, ['branch', '--show-current']),
    out(root, ['rev-parse', '--short', 'HEAD']),
    stashEntries(root),
  ]);
  const files = (status ?? '')
    .split('\n')
    .filter((l) => l.length > 3)
    .map((l) => ({ status: l.slice(0, 2), path: l.slice(3) }));
  return { root, branch: branch?.trim() || null, head: head?.trim() ?? '', files, stashes, stashFileCount: stashes.reduce((n, s) => n + s.files.length, 0) };
}

const FRESH_MS = 10_000;
const cache = new Map<string, { at: number; value: GitSummary | null; refreshing: boolean }>();

function load(cwd: string): Promise<GitSummary | null> {
  return serviceGit(cwd).then((g) => (g ? { branch: g.branch, dirty: g.files.length, stashes: g.stashes.length, stashFiles: g.stashFileCount } : null));
}

/**
 * A summary for the service list, which refreshes every few seconds. Counting the files of many
 * stash entries takes a git call each, so after the first load a stale value is returned at once
 * and refreshed in the background.
 */
export async function gitSummary(cwd: string): Promise<GitSummary | null> {
  const hit = cache.get(cwd);
  if (!hit) {
    const value = await load(cwd);
    cache.set(cwd, { at: Date.now(), value, refreshing: false });
    return value;
  }
  if (Date.now() - hit.at > FRESH_MS && !hit.refreshing) {
    hit.refreshing = true;
    void load(cwd).then(
      (value) => cache.set(cwd, { at: Date.now(), value, refreshing: false }),
      () => (hit.refreshing = false),
    );
  }
  return hit.value;
}

/** Forget cached summaries so the next call reads git again (a manual Refresh). */
export function clearGitCache(): void {
  cache.clear();
}
