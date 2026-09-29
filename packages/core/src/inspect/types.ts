export type InProgressOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | 'none';

export interface Worktree {
  path: string;
  /** Short branch name, or null when detached or bare. */
  branch: string | null;
  isMain: boolean;
  locked: boolean;
  /** Git reports the worktree directory as missing. */
  prunable: boolean;
}

export interface WorktreeDetails extends Worktree {
  uncommitted: number;
  untracked: number;
  /** Commits on the worktree's branch that are on no remote. */
  unpushed: number;
}

export interface ChangeCounts {
  uncommitted: number;
  untracked: number;
}

export interface RepoState extends ChangeCounts {
  path: string;
  /** Short branch name, or null when HEAD is detached. */
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  inProgress: InProgressOperation;
  worktrees: Worktree[];
}
