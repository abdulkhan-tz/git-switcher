import type { HistoryEntry, PromptRequest, Prompter, RunResult, StepEvent } from '@git-helper/core';
import type { Out } from './io.js';

export function renderEvent(out: Out, e: StepEvent): void {
  if (e.status === 'start') return;
  const mark = e.status === 'ok' ? out.green('✓') : e.status === 'skip' ? out.dim('–') : out.red('✗');
  const text = e.status === 'fail' ? out.red(e.message) : e.status === 'skip' ? out.dim(e.message) : e.message;
  out.line(`  ${mark} ${e.step.padEnd(9)} ${text}`);
}

export function renderResult(out: Out, r: RunResult): void {
  if (r.outcome === 'switched') out.line(out.green(`  ✔ on ${r.to}`));
  else if (r.outcome === 'cancelled') out.line(out.yellow(`  ⊘ cancelled — nothing was changed`));
  else {
    out.line(out.red(`  ✘ stopped at ${r.failedStep}`));
    for (const l of (r.recovery ?? '').split('\n').filter(Boolean)) out.line(out.yellow(`    ${l}`));
  }
}

export function renderSummary(out: Out, rows: { name: string; result: RunResult }[]): void {
  out.line();
  out.line(out.bold('Summary'));
  const width = Math.max(...rows.map((r) => r.name.length));
  for (const { name, result } of rows) {
    const status =
      result.outcome === 'switched'
        ? out.green('switched')
        : result.outcome === 'cancelled'
          ? out.yellow('cancelled')
          : out.red(`failed at ${result.failedStep}`) + (result.stashRef ? out.yellow(` (changes in ${result.stashRef})`) : '');
    out.line(`  ${name.padEnd(width)}  ${status}`);
  }
}

export function renderHistory(out: Out, entries: HistoryEntry[]): void {
  if (entries.length === 0) return out.line(out.dim('No runs recorded yet.'));
  for (const e of entries) {
    const outcome =
      e.outcome === 'switched' ? out.green(e.outcome) : e.outcome === 'cancelled' ? out.yellow(e.outcome) : out.red(`failed@${e.failedStep}`);
    out.line(`${out.dim(e.runId)}  ${out.dim(e.startedAt)}  ${outcome.padEnd(10)}  ${e.from ?? '(detached)'} → ${e.to}  ${out.dim(e.repo)}`);
    if (e.stashRef) out.line(out.yellow(`    stash left: ${e.stashRef} "${e.stashMessage}"`));
  }
}

function describeWorktree(req: Extract<PromptRequest, { worktree: unknown }>): string[] {
  const w = req.worktree;
  return [
    `  path:        ${w.path}`,
    `  uncommitted: ${w.uncommitted} changed, ${w.untracked} untracked`,
    `  unpushed:    ${w.unpushed} commit(s) not on any remote (they stay on the branch)`,
    `  locked:      ${w.locked ? 'yes' : 'no'}`,
  ];
}

export function terminalPrompter(out: Out, ask: (q: string) => Promise<string>): Prompter {
  return async (req) => {
    out.line();
    switch (req.kind) {
      case 'createBranch': {
        out.line(out.yellow(`Branch "${req.branch}" does not exist locally or on the remote.`));
        if (req.baseIsFallback) out.line(out.dim('  (no remote default branch found; base is the current HEAD)'));
        const a = await ask(`Create it from ${req.base}? [y/N] `);
        return /^y(es)?$/i.test(a);
      }
      case 'removeWorktree': {
        out.line(out.yellow(`"${req.branch}" is checked out in another worktree:`));
        for (const l of describeWorktree(req)) out.line(l);
        const a = await ask('Delete that worktree and continue? [y/N] ');
        return /^y(es)?$/i.test(a);
      }
      case 'fixBranchCase': {
        out.line(out.yellow(`Local branch "${req.branch}" is stored as "${req.stored}".`));
        out.line(out.dim('  (macOS ignores case in file names, so git folded it into an existing directory)'));
        const a = await ask(`Rename it to exactly "${req.branch}"? [y/N] `);
        return /^y(es)?$/i.test(a);
      }
      case 'confirmDirtyWorktree': {
        out.line(out.red(`The worktree has ${req.worktree.uncommitted + req.worktree.untracked} uncommitted/untracked file(s).`));
        out.line(out.red('Deleting it DESTROYS those changes permanently.'));
        const a = await ask('Type "yes" to delete anyway: ');
        return a === 'yes';
      }
    }
  };
}
