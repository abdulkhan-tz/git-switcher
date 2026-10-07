import { readFileSync } from 'node:fs';
import { ServiceError, ServiceManager, validateDef, type ServiceEvent, type ServiceState, type ServiceStatus } from '@tidy/core';
import { str, type ParsedArgs } from './args.js';
import type { Out } from './io.js';

class UsageError extends Error {}
export { UsageError as ServicesUsageError };

const SERVICES_USAGE = `git-tidy services                         what is up and what is down
git-tidy services up [name…]              start in the background (dependencies first; none = all)
git-tidy services down [name…]            stop the ones git tidy started (none = all)
git-tidy services restart <name…>
git-tidy services logs <name> [--lines n]
git-tidy services add <name> --cwd <dir> --command <cmd> --port <n> [--prepare <cmd>] [--depends a,b] [--description text]
git-tidy services import <file.json>      add or replace definitions from a file ({"services":[…]})
git-tidy services rm <name>`;

const LABEL: Record<ServiceState, { text: string; paint: (o: Out) => (s: string) => string }> = {
  up: { text: '● up', paint: (o) => o.green },
  external: { text: '● up (elsewhere)', paint: (o) => o.yellow },
  starting: { text: '◌ starting', paint: (o) => o.yellow },
  down: { text: '○ down', paint: (o) => o.dim },
};

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
      return out.line(`${out.green('✓')} ${e.name}: stopped`);
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
        return 0;
      case 'up':
        await manager.up(names, (e) => event(out, e));
        return 0;
      case 'down':
        await manager.down(names, (e) => event(out, e));
        return 0;
      case 'restart': {
        if (names.length === 0) throw new UsageError('git-tidy services restart <name…>');
        await manager.down(names, (e) => event(out, e));
        await manager.up(names, (e) => event(out, e));
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
        let parsed: { services?: unknown[] };
        try {
          parsed = JSON.parse(readFileSync(names[0], 'utf8')) as { services?: unknown[] };
        } catch (e) {
          throw new ServiceError(`cannot read ${names[0]}: ${(e as Error).message}`);
        }
        if (!Array.isArray(parsed.services)) throw new ServiceError('the file must look like {"services": [ … ]}');
        const defs = parsed.services.map(validateDef); // validate all before saving any
        for (const d of defs) out.line(`${manager.store.put(d) ? 'Updated' : 'Added'} ${out.bold(d.name)} (port ${d.port})`);
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
