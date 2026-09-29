import type { WorktreeDetails } from '../inspect/types.js';

export const STEPS = ['preflight', 'fetch', 'resolve', 'worktree', 'refs', 'stash', 'checkout', 'pull', 'pop'] as const;
export type Step = (typeof STEPS)[number];

export interface SwitchOptions {
  /** Remote to fetch and track from. Default `origin`. */
  remote?: string;
  /** Start point offered when the branch does not exist anywhere. Default: the remote's HEAD branch. */
  base?: string;
  /** Fixed run id (tests); otherwise random. */
  runId?: string;
  now?: () => Date;
}

export type PromptRequest =
  | { kind: 'createBranch'; repo: string; branch: string; base: string; baseIsFallback: boolean }
  | { kind: 'removeWorktree'; repo: string; branch: string; worktree: WorktreeDetails }
  | { kind: 'confirmDirtyWorktree'; repo: string; branch: string; worktree: WorktreeDetails }
  /** The local branch exists but git stored it with different case (e.g. `Feature/x` for `feature/x`). */
  | { kind: 'fixBranchCase'; repo: string; branch: string; stored: string };

/** Answers a question the engine cannot decide alone. true = proceed, false = cancel. */
export type Prompter = (request: PromptRequest) => Promise<boolean>;

export type StepStatus = 'start' | 'ok' | 'skip' | 'fail';

export interface StepEvent {
  runId: string;
  repo: string;
  step: Step;
  status: StepStatus;
  message: string;
}

export type Outcome = 'switched' | 'cancelled' | 'failed';

export interface RunResult {
  runId: string;
  repo: string;
  from: string | null;
  to: string;
  outcome: Outcome;
  startedAt: string;
  finishedAt: string;
  failedStep?: Step;
  error?: string;
  /** Message of the stash this run created, if it created one. */
  stashMessage?: string;
  /** Set when the run's own stash is still in the stash list at the end (i.e. not restored). */
  stashRef?: string;
  conflictedFiles?: string[];
  /** Human-readable instructions for getting back to a good state. */
  recovery?: string;
  events: StepEvent[];
}
