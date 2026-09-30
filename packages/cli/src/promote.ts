import { PromotionError, PromotionWorker, RegistryError, validInterval, type Promotion, type PromotionStep, type Registry } from '@git-helper/core';
import { str, type ParsedArgs } from './args.js';
import type { Out } from './io.js';

export interface PromoteDeps {
  registry: Registry;
  /** Injected in tests (fake GitHub, fast interval). */
  worker?: PromotionWorker;
  /** How often --watch re-reads state. */
  watchMs?: number;
  /** Called when --watch starts; resolves when it should stop early (Ctrl-C). */
  interrupt?: () => Promise<void>;
}

class UsageError extends Error {}
export { UsageError as PromoteUsageError };

function stepLine(out: Out, s: PromotionStep): string {
  const icon: Record<PromotionStep['status'], string> = {
    merged: out.green('✓'),
    skipped: out.dim('–'),
    open: out.yellow('●'),
    pending: out.dim('·'),
    closed: out.red('✗'),
    failed: out.red('✗'),
  };
  const label = `${s.from} → ${s.to}`.padEnd(24);
  const link = s.pr ? `  ${s.status === 'open' ? out.bold(s.pr.url) : out.dim(`#${s.pr.number}`)}` : '';
  const hint = s.status === 'open' ? out.yellow('  ← waiting for merge') : '';
  const msg = s.status === 'failed' || s.status === 'closed' || s.status === 'skipped' ? `  ${out.dim(s.message ?? '')}` : '';
  return `  ${icon[s.status]} ${label} ${s.status.padEnd(8)}${link}${hint}${msg}${s.autoMerge ? out.dim('  [auto-merge]') : ''}`;
}

export function renderPromotion(out: Out, p: Promotion): void {
  const color = p.status === 'done' ? out.green : p.status === 'running' ? out.bold : p.status === 'stopped' ? out.yellow : out.red;
  out.line(`${out.bold(p.repoName)}  ${out.dim(p.id)}  ${color(p.status)}${p.slug ? out.dim(`  ${p.slug}`) : ''}`);
  for (const s of p.steps) out.line(stepLine(out, s));
  if (p.error && p.status !== 'aborted') out.line(out.red(`  ${p.error}`));
}

const toStepKey = (k: string) => k.replace(':', '→');

export function pipelineCommand(rest: string[], args: ParsedArgs, out: Out, registry: Registry): number {
  const [sub, repo, ...stages] = rest;
  switch (sub) {
    case 'set': {
      if (!repo || stages.length < 2) throw new UsageError('git-helper pipeline set <repo> <stage> <stage>… [--auto-merge develop:qa,qa:stage]');
      const auto = str(args.flags, 'auto-merge');
      const entry = registry.setPipeline(repo, { stages, autoMerge: auto ? auto.split(',').map(toStepKey) : undefined });
      out.line(`${out.bold(entry.name)}: ${entry.pipeline!.stages.join(' → ')}${entry.pipeline!.autoMerge ? out.dim(`  auto-merge: ${entry.pipeline!.autoMerge.join(', ')}`) : ''}`);
      return 0;
    }
    case 'clear':
      if (!repo) throw new UsageError('git-helper pipeline clear <repo>');
      registry.setPipeline(repo, null);
      out.line(`Cleared pipeline for ${repo}`);
      return 0;
    case 'show':
    case 'ls':
    case undefined: {
      const repos = repo ? [registry.find(repo)].filter((r) => r !== undefined) : registry.list();
      if (repo && repos.length === 0) throw new RegistryError(`no registered repo "${repo}"`);
      for (const r of repos) {
        const p = r.pipeline;
        out.line(`${out.bold(r.name.padEnd(12))} ${p ? p.stages.join(' → ') : out.dim('(no pipeline)')}${p?.autoMerge ? out.dim(`  auto-merge: ${p.autoMerge.join(', ')}`) : ''}`);
      }
      return 0;
    }
    default:
      throw new UsageError('git-helper pipeline set|show|clear');
  }
}

export async function promoteCommand(rest: string[], args: ParsedArgs, out: Out, deps: PromoteDeps): Promise<number> {
  const poll = str(args.flags, 'poll');
  const worker = deps.worker ?? new PromotionWorker({ registry: deps.registry, intervalMs: poll ? validInterval(poll) * 1000 : undefined });
  const group = str(args.flags, 'group');
  const refs = group ? deps.registry.groupRepos(group).filter((r) => r.pipeline).map((r) => r.name) : rest;
  if (refs.length === 0) throw new UsageError(group ? `no repo in group "${group}" has a pipeline` : 'git-helper promote <repo…> | --group <name> [--from <stage>] [--watch]');

  const started: Promotion[] = [];
  let failed = false;
  for (const ref of refs) {
    try {
      const p = await worker.startPromotion(ref, { from: str(args.flags, 'from') });
      started.push(p);
      renderPromotion(out, p);
    } catch (e) {
      if (!(e instanceof PromotionError || e instanceof RegistryError)) throw e;
      out.line(out.red(`${ref}: ${e.message}`));
      failed = true;
    }
  }
  if (started.length === 0) return 1;
  if (!args.flags.watch) {
    out.line();
    out.line(out.dim('Merge each PR on GitHub. The worker in `git-helper ui` / the tray app opens the next one,'));
    out.line(out.dim('or run with --watch to keep this terminal polling.'));
    return failed ? 1 : 0;
  }
  const code = await watch(started.map((p) => p.id), out, worker, deps);
  return failed ? 1 : code;
}

async function watch(ids: string[], out: Out, worker: PromotionWorker, deps: PromoteDeps): Promise<number> {
  const owner = worker.start();
  out.line();
  if (owner) out.line(out.dim(`Watching — polling GitHub every ${Math.round(worker.intervalMs / 1000)}s. Ctrl-C stops watching (promotions keep their state).`));
  else out.line(out.dim(`Another git-helper process (pid ${worker.lockHolder()}) is polling; showing its progress. Ctrl-C to exit.`));
  const seen = new Map<string, string>(ids.map((id) => [id, worker.store.get(id)!.updatedAt]));
  let stop = false;
  void deps.interrupt?.().then(() => (stop = true));
  try {
    while (!stop) {
      await new Promise((r) => setTimeout(r, deps.watchMs ?? 5000));
      const current = ids.map((id) => worker.store.get(id)!);
      for (const p of current) {
        if (seen.get(p.id) === p.updatedAt) continue;
        seen.set(p.id, p.updatedAt);
        out.line();
        renderPromotion(out, p);
      }
      if (current.every((p) => p.status !== 'running')) return current.every((p) => p.status === 'done') ? 0 : 1;
    }
    return 0;
  } finally {
    worker.stop();
  }
}

export async function promotionsCommand(rest: string[], out: Out, deps: PromoteDeps): Promise<number> {
  const worker = deps.worker ?? new PromotionWorker({ registry: deps.registry });
  const [sub, id] = rest;
  if (sub === 'interval') {
    if (id !== undefined) worker.setIntervalSec(validInterval(id));
    out.line(`Promotions are checked every ${Math.round(worker.intervalMs / 1000)}s${id !== undefined ? ' (saved; a running worker switches over immediately)' : ''}.`);
    return 0;
  }
  if (sub === 'rm') {
    if (!id) throw new UsageError('git-helper promotions rm <id>');
    const p = worker.deletePromotion(id);
    out.line(`Deleted promotion ${p.id} (${p.repoName}); its PRs on GitHub are untouched.`);
    return 0;
  }
  if (sub === 'clear') {
    out.line(`Deleted ${worker.clearFinished()} finished promotion(s); running ones are kept.`);
    return 0;
  }
  if (sub === 'stop' || sub === 'resume') {
    if (!id) throw new UsageError(`git-helper promotions ${sub} <id>`);
    const p = sub === 'stop' ? worker.stopPromotion(id) : await worker.resumePromotion(id);
    renderPromotion(out, p);
    return 0;
  }
  if (sub !== undefined && sub !== 'ls') throw new UsageError('git-helper promotions [ls | stop <id> | resume <id> | rm <id> | clear | interval [1-60]]');
  const list = worker.store.list().slice(0, 20);
  if (list.length === 0) out.line(out.dim('No promotions yet. Start one with: git-helper promote <repo>'));
  list.forEach((p, i) => {
    if (i) out.line();
    renderPromotion(out, p);
  });
  const st = worker.status();
  out.line();
  if (st.holder) {
    const secs = st.nextCheckAt ? Math.max(0, Math.round((new Date(st.nextCheckAt).getTime() - Date.now()) / 1000)) : null;
    out.line(out.dim(`Worker running (pid ${st.holder}), checking every ${Math.round(st.intervalMs / 1000)}s${secs !== null ? ` — next check in ${secs}s` : ''}.`));
  } else out.line(out.dim('No worker running — start `git-helper ui`, the tray app, or `git-helper promote … --watch`.'));
  return 0;
}
