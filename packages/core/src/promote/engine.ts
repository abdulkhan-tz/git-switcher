import { randomBytes } from 'node:crypto';
import type { RepoEntry } from '../registry/registry.js';
import type { GitHubClient } from './github.js';
import { stepKey, type Promotion, type PromotionEvent, type PromotionStep } from './types.js';

export class PromotionError extends Error {}

const MAX_LISTED_COMMITS = 30;

export function createPromotion(repo: RepoEntry, opts: { from?: string; now?: Date } = {}): Promotion {
  const stages = repo.pipeline?.stages ?? [];
  if (stages.length < 2) throw new PromotionError(`"${repo.name}" has no pipeline; set one with: git-tidy pipeline set ${repo.name} <stage> <stage>…`);
  const start = opts.from ? stages.indexOf(opts.from) : 0;
  if (start === -1) throw new PromotionError(`"${opts.from}" is not a stage of ${repo.name} (${stages.join(' → ')})`);
  if (start >= stages.length - 1) throw new PromotionError(`"${opts.from}" is the last stage of ${repo.name}; nothing to promote into`);
  const at = (opts.now ?? new Date()).toISOString();
  const auto = new Set(repo.pipeline?.autoMerge ?? []);
  const steps: PromotionStep[] = [];
  for (let i = start; i < stages.length - 1; i++) {
    const from = stages[i]!;
    const to = stages[i + 1]!;
    steps.push({ from, to, status: 'pending', autoMerge: auto.has(stepKey(from, to)), updatedAt: at });
  }
  return {
    id: randomBytes(4).toString('hex'),
    repoId: repo.id,
    repoName: repo.name,
    repoPath: repo.path,
    steps,
    status: 'running',
    createdAt: at,
    updatedAt: at,
  };
}

function prBody(from: string, to: string, subjects: string[]): string {
  const listed = subjects.slice(-MAX_LISTED_COMMITS).map((s) => `- ${s}`);
  const more = subjects.length > MAX_LISTED_COMMITS ? [`- …and ${subjects.length - MAX_LISTED_COMMITS} earlier commit(s)`] : [];
  return [`Promotes \`${from}\` into \`${to}\` (${subjects.length} commit(s)).`, '', ...more, ...listed, '', '_Opened by git tidy._'].join('\n');
}

/**
 * Moves a running promotion as far as it can go without waiting on a human: skips steps with
 * nothing to promote, opens (or reuses) the next PR, and moves past PRs that have been merged.
 * Returns a new object; never throws — a GitHub error marks the promotion `failed`.
 */
export async function advance(
  input: Promotion,
  github: GitHubClient,
  onEvent?: (e: PromotionEvent) => void,
  now: () => Date = () => new Date(),
): Promise<Promotion> {
  const p: Promotion = structuredClone(input);
  if (p.status !== 'running') return p;
  const touch = (step?: PromotionStep) => {
    const at = now().toISOString();
    p.updatedAt = at;
    if (step) step.updatedAt = at;
  };
  let current: PromotionStep | undefined;
  try {
    p.slug ??= await github.repoSlug(p.repoPath);
    const slug = p.slug;
    for (const step of p.steps) {
      current = step;
      if (step.status === 'merged' || step.status === 'skipped') continue;
      if (step.status === 'closed') {
        p.status = 'aborted';
        return p;
      }

      if (step.status === 'pending') {
        const cmp = await github.compare(slug, step.to, step.from);
        step.commits = cmp.aheadBy;
        if (cmp.aheadBy === 0) {
          step.status = 'skipped';
          step.message = `${step.to} already contains everything in ${step.from}`;
          touch(step);
          continue;
        }
        let pr = await github.findOpenPr(slug, step.to, step.from);
        const reused = pr !== null;
        pr ??= await github.createPr(slug, {
          base: step.to,
          head: step.from,
          title: `Promote ${step.from} → ${step.to}`,
          body: prBody(step.from, step.to, cmp.subjects),
        });
        step.pr = { number: pr.number, url: pr.url };
        step.status = 'open';
        step.message = `${reused ? 'reused open' : 'opened'} PR #${pr.number} (${cmp.aheadBy} commit(s))`;
        if (step.autoMerge) {
          try {
            await github.enableAutoMerge(slug, pr.number);
            step.message += '; auto-merge enabled';
          } catch (e) {
            step.message += `; auto-merge not enabled: ${(e as Error).message}`;
          }
        }
        touch(step);
        onEvent?.({ type: 'pr-opened', promotion: structuredClone(p), step: structuredClone(step) });
      }

      if (step.status === 'open') {
        const pr = await github.getPr(slug, step.pr!.number);
        if (pr.state === 'MERGED') {
          step.status = 'merged';
          step.message = `PR #${pr.number} merged`;
          touch(step);
          continue;
        }
        if (pr.state === 'CLOSED') {
          step.status = 'closed';
          step.message = `PR #${pr.number} was closed without merging`;
          p.status = 'aborted';
          p.error = step.message;
          touch(step);
          return p;
        }
        return p; // waiting for a human to merge
      }
    }
    p.status = 'done';
    touch();
    return p;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (current) {
      current.status = 'failed';
      current.message = message;
      touch(current);
    }
    p.status = 'failed';
    p.error = message;
    touch();
    return p;
  }
}

/** Prepares a stopped or failed promotion to continue from where it left off. */
export function resumed(input: Promotion): Promotion {
  const p: Promotion = structuredClone(input);
  if (p.status === 'done' || p.status === 'running') return p;
  for (const step of p.steps) {
    if (step.status === 'failed') step.status = step.pr ? 'open' : 'pending';
    // A closed PR can be reopened on GitHub; re-check it rather than giving up.
    if (step.status === 'closed') step.status = 'open';
  }
  p.status = 'running';
  delete p.error;
  return p;
}
