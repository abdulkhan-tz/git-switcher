import { ServiceManager, History, PromotionError, Registry, RegistryError, SettingsError, repairCase, inspect, repoExists, repoRoot, switchBranch, type RunResult, type SwitchOptions } from '@git-helper/core';
import { parseArgs, str, type ParsedArgs } from './args.js';
import { lineReader, makeOut, type Io, type Out } from './io.js';
import { pipelineCommand, promoteCommand, promotionsCommand, PromoteUsageError, type PromoteDeps } from './promote.js';
import { servicesCommand } from './services.js';
import { renderEvent, renderHistory, renderResult, renderSummary, terminalPrompter } from './render.js';

export const VERSION = '0.1.0';

const USAGE = `git helper — switch branches safely and promote them upstream. (alias: gsw)

Switch  (stash → switch → pull → pop; stops at the first error, never loses work)
  git-helper <branch>                        switch the current repo
  git-helper <branch> --group <name>         switch every repo in a group
  git-helper <branch> --repos a,b            switch the named registered repos
  git-helper switch <branch> [...]           same, for branch names that clash with a command
      --remote <name>                        remote to fetch/track (default: repo setting or origin)
      --base <ref>                           start point if the branch must be created

Promote  (one PR per step; the next opens when you merge the previous one)
  git-helper pipeline set <repo> <stage> <stage>… [--auto-merge develop:qa,qa:stage]
  git-helper pipeline show [repo] | clear <repo>
  git-helper promote <repo…> | --group <name> [--from <stage>] [--watch] [--poll <sec>]
  git-helper promotions [stop <id> | resume <id> | rm <id> | clear]
  git-helper promotions interval [1-60]      show or set how often GitHub is checked (seconds)
  git-helper promotions checks [on|off]      pause or resume all promotion checks

Services  (run local dev processes in the background and see what is up)
  git-helper services [up|down|restart|logs|add|import|rm] [name…]   (details: git-helper services help)

Repos
  git-helper add [path] [--name n] [--base origin/develop] [--remote origin]
  git-helper set <repo> [--name n] [--base ref] [--remote r]   ("" clears base/remote)
  git-helper rm <repo>
  git-helper ls                              registered repos with branch and state
  git-helper repair [--group <name>]         fix checkouts whose branch macOS stored with the wrong case
  git-helper group add <name> <repo...>      create or replace a group
  git-helper group rm <name> | group ls
  git-helper history [--repo <repo>] [--limit n]
  git-helper history rm <run-id> | clear [--repo <repo>]
  git-helper ui [--port n] [--no-open]       open the dashboard (also runs the promotion worker)

Exit codes: 0 success, 1 any failure, 2 any cancelled switch.`;

export interface Deps {
  registry?: Registry;
  history?: History;
  /** Launches the dashboard (phase 2); injected so the CLI does not hard-depend on the server. */
  startUi?: (opts: { port?: number; open: boolean }, out: Out) => Promise<number>;
  promote?: Omit<PromoteDeps, 'registry'>;
  services?: ServiceManager;
}

export async function main(argv: string[], io: Io, deps: Deps = {}): Promise<number> {
  const out = makeOut(io);
  const registry = deps.registry ?? new Registry();
  const history = deps.history ?? new History();
  const args = parseArgs(argv);
  const [command, ...rest] = args.positional;

  try {
    if (args.flags.version) return out.line(VERSION), 0;
    if (args.flags.help || command === undefined || command === 'help') return out.line(USAGE), command === undefined && !args.flags.help ? 1 : 0;

    switch (command) {
      case 'switch':
        if (!rest[0]) throw new UsageError('git-helper switch <branch>');
        return await runSwitch(rest[0], args, io, out, registry, history);
      case 'add': {
        const entry = await registry.add(rest[0] ?? io.cwd, { name: str(args.flags, 'name'), base: str(args.flags, 'base'), remote: str(args.flags, 'remote') });
        out.line(`Registered ${out.bold(entry.name)} → ${entry.path}${entry.base ? `  (base ${entry.base})` : ''}`);
        return 0;
      }
      case 'set': {
        if (!rest[0]) throw new UsageError('git-helper set <repo> [--name n] [--base ref] [--remote r]');
        const entry = registry.update(rest[0], { name: str(args.flags, 'name'), base: str(args.flags, 'base'), remote: str(args.flags, 'remote') });
        out.line(`Updated ${out.bold(entry.name)}: base ${entry.base ?? '(remote default)'}, remote ${entry.remote ?? 'origin'}`);
        return 0;
      }
      case 'rm': {
        if (!rest[0]) throw new UsageError('git-helper rm <repo>');
        const entry = registry.remove(rest[0]);
        out.line(`Removed ${entry.name} (files untouched)`);
        return 0;
      }
      case 'ls':
        return await list(out, registry);
      case 'repair':
        return await repair(args, io, out, registry);
      case 'group':
        return group(rest, out, registry);
      case 'history': {
        const repoRef = str(args.flags, 'repo');
        const repo = repoRef ? (registry.find(repoRef)?.path ?? repoRef) : undefined;
        if (rest[0] === 'rm') {
          if (!rest[1]) throw new UsageError('git-helper history rm <run-id>');
          if (!history.remove(rest[1])) throw new UsageError(`no single history entry matches "${rest[1]}"`);
          out.line(`Deleted history entry ${rest[1]}`);
          return 0;
        }
        if (rest[0] === 'clear') {
          out.line(`Deleted ${history.clear({ repo })} history entr${repo ? `ies for ${repoRef}` : 'ies'}`);
          return 0;
        }
        renderHistory(out, history.list({ repo, limit: Number(str(args.flags, 'limit') ?? 20) }));
        return 0;
      }
      case 'pipeline':
        return pipelineCommand(rest, args, out, registry);
      case 'promote':
        return await promoteCommand(rest, args, out, { registry, ...deps.promote });
      case 'promotions':
        return await promotionsCommand(rest, out, { registry, ...deps.promote });
      case 'services':
      case 'svc':
        return await servicesCommand(rest, args, out, deps.services);
      case 'ui': {
        if (!deps.startUi) throw new UsageError('the dashboard is not available in this build');
        const port = str(args.flags, 'port');
        return await deps.startUi({ port: port ? Number(port) : undefined, open: !args.flags['no-open'] }, out);
      }
      default:
        return await runSwitch(command, args, io, out, registry, history);
    }
  } catch (e) {
    if (e instanceof UsageError || e instanceof PromoteUsageError) out.line(out.red(`usage: ${e.message}`));
    else if (e instanceof RegistryError || e instanceof PromotionError || e instanceof SettingsError) out.line(out.red(e.message));
    else out.line(out.red(e instanceof Error ? e.message : String(e)));
    return 1;
  }
}

class UsageError extends Error {}

async function runSwitch(branch: string, args: ParsedArgs, io: Io, out: Out, registry: Registry, history: History): Promise<number> {
  const prompter = terminalPrompter(out, lineReader(io));
  const override: SwitchOptions = {};
  if (str(args.flags, 'remote')) override.remote = str(args.flags, 'remote');
  if (str(args.flags, 'base')) override.base = str(args.flags, 'base');

  const groupName = str(args.flags, 'group');
  const repoList = str(args.flags, 'repos');
  let targets: { name: string; path: string; options: SwitchOptions }[];
  if (groupName || repoList) {
    const entries = groupName
      ? registry.groupRepos(groupName)
      : repoList!.split(',').map((ref) => {
          const e = registry.find(ref.trim());
          if (!e) throw new RegistryError(`no registered repo "${ref.trim()}"`);
          return e;
        });
    if (entries.length === 0) throw new RegistryError('no repos to switch');
    targets = entries.map((e) => ({ name: e.name, path: e.path, options: { remote: e.remote, base: e.base, ...override } }));
  } else {
    const root = await repoRoot(io.cwd).catch(() => io.cwd);
    const entry = registry.byRoot(root);
    targets = [{ name: entry?.name ?? root, path: root, options: { remote: entry?.remote, base: entry?.base, ...override } }];
  }

  const multi = targets.length > 1;
  const rows: { name: string; result: RunResult }[] = [];
  for (const t of targets) {
    if (multi || targets[0]!.name !== t.path) out.line(out.bold(`▸ ${t.name}`) + out.dim(`  ${t.path}`));
    const result = await switchBranch(t.path, branch, t.options, prompter, (e) => renderEvent(out, e));
    renderResult(out, result);
    history.append(result);
    rows.push({ name: t.name, result });
    if (multi) out.line();
  }
  if (multi) renderSummary(out, rows);

  if (rows.some((r) => r.result.outcome === 'failed')) return 1;
  if (rows.some((r) => r.result.outcome === 'cancelled')) return 2;
  return 0;
}

/** Fixes checkouts whose branch a case-insensitive disk stored with different case. */
async function repair(args: ParsedArgs, io: Io, out: Out, registry: Registry): Promise<number> {
  const group = str(args.flags, 'group');
  const targets = group ? registry.groupRepos(group).map((r) => ({ name: r.name, path: r.path })) : [{ name: io.cwd, path: io.cwd }];
  let failed = false;
  for (const t of targets) {
    try {
      const repaired = await repairCase(t.path);
      if (repaired.length === 0) out.line(`${out.bold(t.name)}: ${out.dim('nothing to repair')}`);
      for (const f of repaired) out.line(`${out.bold(t.name)}: ${out.green('repaired')} ${f.stored} → ${f.head}  ${out.dim(f.path)}`);
    } catch (e) {
      failed = true;
      out.line(`${out.bold(t.name)}: ${out.red((e as Error).message)}`);
    }
  }
  return failed ? 1 : 0;
}

async function list(out: Out, registry: Registry): Promise<number> {
  const repos = registry.list();
  if (repos.length === 0) {
    out.line(out.dim('No repos registered. Add one with: git-helper add [path]'));
    return 0;
  }
  const width = Math.max(...repos.map((r) => r.name.length));
  for (const r of repos) {
    if (!repoExists(r)) {
      out.line(`${r.name.padEnd(width)}  ${out.red('missing')}  ${out.dim(r.path)}`);
      continue;
    }
    try {
      const s = await inspect(r.path);
      const bits = [
        out.bold(s.branch ?? '(detached)'),
        s.uncommitted ? out.yellow(`${s.uncommitted} changed`) : '',
        s.untracked ? out.yellow(`${s.untracked} untracked`) : '',
        s.ahead ? `↑${s.ahead}` : '',
        s.behind ? `↓${s.behind}` : '',
        s.inProgress !== 'none' ? out.red(s.inProgress) : '',
        s.worktrees.length > 1 ? out.dim(`${s.worktrees.length - 1} worktree(s)`) : '',
      ].filter(Boolean);
      out.line(`${r.name.padEnd(width)}  ${bits.join('  ')}  ${out.dim(r.path)}`);
    } catch (e) {
      out.line(`${r.name.padEnd(width)}  ${out.red(e instanceof Error ? e.message : String(e))}`);
    }
  }
  const groups = registry.groups();
  if (groups.length) {
    out.line();
    for (const g of groups) out.line(`${out.bold('group')} ${g.name}: ${registry.groupRepos(g.name).map((r) => r.name).join(', ')}`);
  }
  return 0;
}

function group(rest: string[], out: Out, registry: Registry): number {
  const [sub, name, ...repos] = rest;
  switch (sub) {
    case 'add':
      if (!name || repos.length === 0) throw new UsageError('git-helper group add <name> <repo...>');
      registry.setGroup(name, repos);
      out.line(`Group ${out.bold(name)}: ${registry.groupRepos(name).map((r) => r.name).join(', ')}`);
      return 0;
    case 'rm':
      if (!name) throw new UsageError('git-helper group rm <name>');
      registry.removeGroup(name);
      out.line(`Removed group ${name}`);
      return 0;
    case 'ls':
    case undefined:
      for (const g of registry.groups()) out.line(`${g.name}: ${registry.groupRepos(g.name).map((r) => r.name).join(', ')}`);
      return 0;
    default:
      throw new UsageError('git-helper group add|rm|ls');
  }
}
