import { readFileSync } from 'node:fs';
import { ServiceError, ServiceManager, listBranches, serviceGit, validateDef, type ServiceEvent, type ServiceState, type ServiceStatus } from '@tidy/core';
import { str, type ParsedArgs } from './args.js';
import type { Out } from './io.js';

class UsageError extends Error {}
export { UsageError as ServicesUsageError };

const SERVICES_USAGE = `git-tidy services                         what is up and what is down
git-tidy services show <name>               folder, command, build step, env, port, dependencies, log file
git-tidy services up [name|group…]          start in the background, in the order given (each one's dependencies first; none = all)
git-tidy services down [name|group…]            stop the ones git tidy started (none = all)
git-tidy services restart <name…>
git-tidy services logs <name> [--lines n]
git-tidy services branch <name>             the branch it runs on, and the branches it could switch to
git-tidy services switch <name> <branch> [--no-restart]   stop it, switch its checkout (uncommitted files are stashed and restored), start it again
git-tidy services rename <name> <new-name>  (dependencies, groups and logs follow)
git-tidy services set <name> [--cwd d] [--command c] [--prepare c|""] [--port n] [--depends a,b|""] [--description t] [--timeout sec]
git-tidy services group                     list groups
git-tidy services group set <group> <name…> create or replace a group; the order given is the start order
git-tidy services group rename <group> <new-name>
git-tidy services group rm <group>
git-tidy services add <name> --cwd <dir> --command <cmd> --port <n> [--prepare <cmd>] [--depends a,b] [--description text]
git-tidy services import <file.json>      add or replace definitions from a file ({"services":[…]})
git-tidy services rm <name>`;

const LABEL: Record<ServiceState, { text: string; paint: (o: Out) => (s: string) => string }> = {
  up: { text: '● up', paint: (o) => o.green },
  external: { text: '● up (elsewhere)', paint: (o) => o.yellow },
  starting: { text: '◌ starting', paint: (o) => o.yellow },
  down: { text: '○ down', paint: (o) => o.dim },
};

export function renderShow(out: Out, r: ServiceStatus): void {
  const row = (k: string, v: string | undefined) => v !== undefined && v !== '' && out.line(`  ${out.dim(k.padEnd(11))} ${v}`);
  out.line(`${out.bold(r.name)}  ${LABEL[r.state].paint(out)(LABEL[r.state].text)}${r.pid ?? r.externalPid ? out.dim(`  pid ${r.pid ?? r.externalPid}`) : ''}`);
  row('about', r.description);
  row('groups', r.groups.join(', ') || undefined);
  row('folder', r.cwd);
  row('port', String(r.port));
  row('needs', r.dependsOn.join(', ') || undefined);
  row('prepare', r.prepare);
  row('command', r.command);
  for (const [k, v] of Object.entries(r.env ?? {})) row(k === Object.keys(r.env!)[0] ? 'env' : '', `${k}=${v}`);
  row('timeout', r.startTimeoutSec ? `${r.startTimeoutSec}s` : undefined);
  row('log', r.logFile);
  if (r.externalCommand) row('running as', r.externalCommand);
  if (r.git) row('git', `${r.git.branch ?? '(detached)'} · ${r.git.dirty} uncommitted file${r.git.dirty === 1 ? '' : 's'} · ${r.git.stashes} stash${r.git.stashes === 1 ? '' : 'es'} (${r.git.stashFiles} file${r.git.stashFiles === 1 ? '' : 's'})`);
}

export function renderServices(out: Out, rows: ServiceStatus[]): void {
  if (rows.length === 0) {
    out.line(out.dim('No services defined. Add one with: git-tidy services add, or import a file.'));
    return;
  }
  const width = Math.max(...rows.map((r) => r.name.length));
  for (const r of rows) {
    const pid = r.pid ?? r.externalPid;
    out.line(`${out.bold(r.name.padEnd(width))}  ${LABEL[r.state].paint(out)(LABEL[r.state].text.padEnd(16))} :${r.port}${pid ? out.dim(`  pid ${pid}`) : ''}${r.description ? out.dim(`  ${r.description}`) : ''}`);
  }
}

function event(out: Out, e: ServiceEvent): void {
  switch (e.type) {
    case 'skip':
      return out.line(`${out.dim('–')} ${e.name}: ${out.dim(e.reason)}`);
    case 'prepare':
      return out.line(`${out.dim('·')} ${e.name}: preparing (build if needed)…`);
    case 'start':
      return out.line(`${out.dim('·')} ${e.name}: started (pid ${e.pid}), waiting for its port…  ${out.dim(e.logFile)}`);
    case 'ready':
      return out.line(`${out.green('✓')} ${e.name}: up after ${e.seconds}s`);
    case 'stopped':
      return out.line(`${out.green('✓')} ${e.name}: stopped${e.external ? out.dim(' (was started elsewhere)') : ''}`);
  }
}

export async function servicesCommand(rest: string[], args: ParsedArgs, out: Out, manager: ServiceManager = new ServiceManager()): Promise<number> {
  const [sub, ...names] = rest;
  try {
    switch (sub) {
      case undefined:
      case 'ls':
      case 'status':
        renderServices(out, await manager.status());
        for (const g of manager.store.groups()) out.line(`${out.dim('group')} ${out.bold(g.name)}  ${g.members.join(out.dim(' → '))}`);
        return 0;
      case 'show': {
        if (!names[0]) throw new UsageError('git-tidy services show <name>');
        renderShow(out, (await manager.status(names[0], { git: true }))[0]!);
        return 0;
      }
      case 'branch': {
        if (!names[0]) throw new UsageError('git-tidy services branch <name>');
        const git = await serviceGit(manager.store.get(names[0]).cwd);
        if (!git) throw new ServiceError(`${names[0]}: not inside a git repository`);
        const { branches } = await listBranches(git.root);
        out.line(`${out.bold(names[0])} runs ${out.bold(git.branch ?? '(detached)')} @ ${git.head}  ${out.dim(git.root)}`);
        out.line(out.dim(`${branches.length} branches available: git-tidy services switch ${names[0]} <branch>`));
        return 0;
      }
      case 'switch': {
        if (!names[0] || !names[1]) throw new UsageError('git-tidy services switch <name> <branch> [--no-restart]');
        const { result, restarted } = await manager.switchBranch(names[0], names[1], {
          restart: args.flags['no-restart'] !== true,
          onStep: (e) => e.status !== 'start' && out.line(`${out.dim('·')} ${e.step}: ${e.message || e.status}`),
          on: (e) => event(out, e),
        });
        if (result.outcome === 'switched') out.line(`${out.green('✓')} ${names[0]} is on ${out.bold(names[1])}${restarted ? ' and running again' : ''}`);
        else out.line(out.red(`${result.outcome}: ${result.error ?? 'nothing changed'}${result.recovery ? `\n${result.recovery}` : ''}`));
        return result.outcome === 'switched' ? 0 : 1;
      }
      case 'rename': {
        if (!names[0] || !names[1]) throw new UsageError('git-tidy services rename <name> <new-name>');
        manager.store.rename(names[0], names[1]);
        out.line(`Renamed ${out.bold(names[0])} → ${out.bold(names[1])}`);
        return 0;
      }
      case 'set': {
        if (!names[0]) throw new UsageError('git-tidy services set <name> [--cwd d] [--command c] …');
        const f = args.flags;
        const text = (k: string) => (typeof f[k] === 'string' ? (f[k] as string) : undefined);
        const patch = {
          cwd: text('cwd'),
          command: text('command'),
          prepare: text('prepare') === '' ? null : text('prepare'),
          description: text('description'),
          port: text('port') === undefined ? undefined : Number(text('port')),
          startTimeoutSec: text('timeout') === undefined ? undefined : text('timeout') === '' ? null : Number(text('timeout')),
          dependsOn: text('depends') === undefined ? undefined : text('depends')!.split(',').map((x) => x.trim()).filter(Boolean),
        };
        if (Object.values(patch).every((v) => v === undefined)) throw new UsageError('nothing to change; pass at least one of --cwd --command --prepare --port --depends --description --timeout');
        manager.store.update(names[0], patch);
        out.line(`Updated ${out.bold(names[0])} — takes effect the next time it starts`);
        return 0;
      }
      case 'group': {
        const [action, gname, ...members] = names;
        if (!action) {
          const groups = manager.store.groups();
          if (groups.length === 0) out.line(out.dim('No groups. Create one with: git-tidy services group set <group> <name…>'));
          for (const g of groups) out.line(`${out.bold(g.name)}  ${g.members.join(out.dim(' → '))}`);
          return 0;
        }
        if (action === 'set') {
          if (!gname || members.length === 0) throw new UsageError('git-tidy services group set <group> <name…>');
          const g = manager.store.setGroup(gname, members);
          out.line(`Group ${out.bold(g.name)}: ${g.members.join(' → ')}`);
          return 0;
        }
        if (action === 'rename') {
          if (!gname || !members[0]) throw new UsageError('git-tidy services group rename <group> <new-name>');
          manager.store.renameGroup(gname, members[0]);
          out.line(`Renamed group ${out.bold(gname)} → ${out.bold(members[0])}`);
          return 0;
        }
        if (action === 'rm') {
          if (!gname) throw new UsageError('git-tidy services group rm <group>');
          manager.store.removeGroup(gname);
          out.line(`Removed group ${gname} (its services are untouched)`);
          return 0;
        }
        throw new UsageError('git-tidy services group [set <group> <name…> | rename <group> <new-name> | rm <group>]');
      }
      case 'up':
        await manager.up(names, (e) => event(out, e));
        return 0;
      case 'down':
        await manager.down(names, (e) => event(out, e), { external: names.length > 0 || args.flags.external === true });
        return 0;
      case 'restart': {
        if (names.length === 0) throw new UsageError('git-tidy services restart <name|group…>');
        await manager.restart(names, (e) => event(out, e));
        return 0;
      }
      case 'logs': {
        if (!names[0]) throw new UsageError('git-tidy services logs <name> [--lines n]');
        const text = manager.tail(names[0], Number(str(args.flags, 'lines') ?? 50));
        out.line(text || out.dim('(no log yet)'));
        out.line(out.dim(manager.store.logFile(names[0])));
        return 0;
      }
      case 'add': {
        const [name] = names;
        if (!name) throw new UsageError(SERVICES_USAGE);
        const def = validateDef({
          name,
          cwd: str(args.flags, 'cwd'),
          command: str(args.flags, 'command'),
          port: Number(str(args.flags, 'port')),
          prepare: str(args.flags, 'prepare'),
          description: str(args.flags, 'description'),
          dependsOn: str(args.flags, 'depends')?.split(',').map((s) => s.trim()).filter(Boolean),
        });
        const replaced = manager.store.put(def);
        out.line(`${replaced ? 'Updated' : 'Added'} ${out.bold(def.name)} (port ${def.port})`);
        return 0;
      }
      case 'import': {
        if (!names[0]) throw new UsageError('git-tidy services import <file.json>');
        let parsed: { services?: unknown[]; groups?: { name: string; members: string[] }[] };
        try {
          parsed = JSON.parse(readFileSync(names[0], 'utf8')) as typeof parsed;
        } catch (e) {
          throw new ServiceError(`cannot read ${names[0]}: ${(e as Error).message}`);
        }
        if (!Array.isArray(parsed.services)) throw new ServiceError('the file must look like {"services": [ … ]}');
        const defs = parsed.services.map(validateDef); // validate all before saving any
        for (const d of defs) out.line(`${manager.store.put(d) ? 'Updated' : 'Added'} ${out.bold(d.name)} (port ${d.port})`);
        for (const g of parsed.groups ?? []) out.line(`Group ${out.bold(g.name)}: ${manager.store.setGroup(g.name, g.members).members.join(' → ')}`);
        return 0;
      }
      case 'rm': {
        if (!names[0]) throw new UsageError('git-tidy services rm <name>');
        out.line(`Removed ${manager.store.remove(names[0]).name} (a running process is not stopped)`);
        return 0;
      }
      default:
        throw new UsageError(SERVICES_USAGE);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      out.line(out.red(`usage:\n${e.message}`));
      return 1;
    }
    if (e instanceof ServiceError) {
      out.line(out.red(e.message));
      return 1;
    }
    throw e;
  }
}
