export interface Pipeline {
  /** Branch names in promotion order, e.g. ["develop", "qa", "stage", "main"]. */
  stages: string[];
  /** Step keys (`from→to`) whose PRs get GitHub auto-merge enabled. */
  autoMerge?: string[];
}

export const stepKey = (from: string, to: string) => `${from}→${to}`;

export type PromotionStepStatus = 'pending' | 'skipped' | 'open' | 'merged' | 'closed' | 'failed';
export type PromotionStatus = 'running' | 'stopped' | 'done' | 'aborted' | 'failed';

export interface PullRequest {
  number: number;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
}

export interface PromotionStep {
  from: string;
  to: string;
  status: PromotionStepStatus;
  autoMerge: boolean;
  pr?: { number: number; url: string };
  /** Commits that were ahead when the step was evaluated. */
  commits?: number;
  message?: string;
  updatedAt: string;
}

export interface Promotion {
  id: string;
  repoId: string;
  repoName: string;
  repoPath: string;
  /** GitHub `owner/name`. */
  slug?: string;
  steps: PromotionStep[];
  status: PromotionStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type PromotionEvent =
  | { type: 'pr-opened'; promotion: Promotion; step: PromotionStep }
  | { type: 'updated'; promotion: Promotion };
