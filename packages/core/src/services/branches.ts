import { runGit } from '../git/exec.js';

export interface BranchList {
  current: string | null;
  /** Every branch that can be switched to, local and remote-only, without the remote prefix, sorted. */
  branches: string[];
}

/** Branches of the repo at `root`. A remote branch is listed by its short name (`origin/x` → `x`). */
export async function listBranches(root: string): Promise<BranchList> {
  const [refs, current] = await Promise.all([runGit(root, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']), runGit(root, ['branch', '--show-current'])]);
  const names = new Set<string>();
  for (const ref of refs.stdout.split('\n').filter(Boolean)) {
    const name = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref.replace(/^refs\/remotes\/[^/]+\//, '');
    if (name && name !== 'HEAD') names.add(name);
  }
  return { current: current.stdout.trim() || null, branches: [...names].sort((a, b) => a.localeCompare(b)) };
}
