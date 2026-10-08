import { execFile, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { switchBranch } from '../switch/run.js';
import type { RunResult, StepEvent } from '../switch/types.js';
import { gitSummary, serviceGit } from './git.js';
import { ServiceError, ServiceStore, expandHome } from './store.js';
import type { ServiceDef, ServiceEvent, ServiceStatus } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function tryPort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(500, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** Spring and Quarkus bind dual-stack, but some tools bind only ::1 or only 127.0.0.1. */
export async function portOpen(port: number): Promise<boolean> {
  const [v4, v6] = await Promise.all([tryPort('127.0.0.1', port), tryPort('::1', port)]);
  return v4 || v6;
}

function listeningPid(port: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN', '-nP'], (err, stdout) => {
      const pid = err ? NaN : Number(String(stdout).split('\n')[0]);
      resolve(Number.isInteger(pid) && pid > 0 ? pid : undefined);
    });
  });
}

function commandOf(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'command=', '-p', String(pid)], (err, stdout) => resolve(err ? undefined : String(stdout).trim().slice(0, 300) || undefined));
  });
}

/** Runs `sh -c script`, appending its output to the log. Resolves with the exit code. */
function runShell(def: ServiceDef, script: string, logFd: number): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', script], { cwd: expandHome(def.cwd), env: { ...process.env, ...def.env }, stdio: ['ignore', logFd, logFd] });
    child.once('error', () => resolve(127));
    child.once('close', (code) => resolve(code ?? 1));
  });
}

export class ServiceManager {
  constructor(readonly store: ServiceStore = new ServiceStore()) {}

  async status(name?: string, opts: { git?: boolean } = {}): Promise<ServiceStatus[]> {
    const defs = name ? [this.store.get(name)] : this.store.list();
    const running = this.store.running();
    const groups = this.store.groups();
    return Promise.all(
      defs.map(async (d): Promise<ServiceStatus> => {
        const rec = running[d.name];
        const alive = rec ? isAlive(rec.pid) : false;
        if (rec && !alive) this.store.setRunning(d.name, null); // stale record: the process is gone
        const open = await portOpen(d.port);
        const base = { name: d.name, description: d.description, port: d.port, cwd: d.cwd, command: d.command, prepare: d.prepare, env: d.env, startTimeoutSec: d.startTimeoutSec, logFile: this.store.logFile(d.name), dependsOn: d.dependsOn ?? [], groups: groups.filter((g) => g.members.includes(d.name)).map((g) => g.name), git: opts.git ? await gitSummary(d.cwd) : undefined };
        if (alive && open) return { ...base, state: 'up', pid: rec!.pid, startedAt: rec!.startedAt };
        if (alive) return { ...base, state: 'starting', pid: rec!.pid, startedAt: rec!.startedAt };
        if (open) {
          const externalPid = await listeningPid(d.port);
          return { ...base, state: 'external', externalPid, externalCommand: externalPid ? await commandOf(externalPid) : undefined };
        }
        return { ...base, state: 'down' };
      }),
    );
  }

  /** Expands group names into their members, in sequence. Plain service names pass through. */
  resolve(names: string[]): string[] {
    const groups = this.store.groups();
    const out: string[] = [];
    for (const n of names) {
      const g = groups.find((x) => x.name === n);
      if (g) out.push(...g.members);
      else {
        this.store.get(n);
        out.push(n);
      }
    }
    return [...new Set(out)];
  }

  /** `names` plus everything they depend on, dependencies first; otherwise in the order given. */
  order(names: string[]): ServiceDef[] {
    const out: ServiceDef[] = [];
    const seen = new Set<string>();
    const visiting = new Set<string>();
    const visit = (name: string) => {
      if (seen.has(name)) return;
      if (visiting.has(name)) throw new ServiceError(`dependency cycle through "${name}"`);
      visiting.add(name);
      const def = this.store.get(name);
      for (const dep of def.dependsOn ?? []) visit(dep);
      visiting.delete(name);
      seen.add(name);
      out.push(def);
    };
    names.forEach(visit);
    return out;
  }

  /** Starts services (and their dependencies) in the background and waits until each one listens. */
  async up(names: string[], on: (e: ServiceEvent) => void = () => {}): Promise<void> {
    const targets = names.length ? this.resolve(names) : this.store.list().map((s) => s.name);
    for (const def of this.order(targets)) {
      const [st] = await this.status(def.name);
      if (st!.state === 'up' || st!.state === 'external') {
        on({ type: 'skip', name: def.name, reason: st!.state === 'up' ? 'already running' : `already running outside git tidy${st!.externalPid ? ` (pid ${st!.externalPid})` : ''}` });
        continue;
      }
      if (st!.state === 'starting') on({ type: 'skip', name: def.name, reason: 'already starting' });
      else await this.launch(def, on);
      await this.waitReady(def, on);
    }
  }

  private async launch(def: ServiceDef, on: (e: ServiceEvent) => void): Promise<void> {
    const cwd = expandHome(def.cwd);
    try {
      if (!statSync(cwd).isDirectory()) throw new Error();
    } catch {
      throw new ServiceError(`${def.name}: working directory ${cwd} does not exist`);
    }
    mkdirSync(this.store.logDir, { recursive: true });
    const logFile = this.store.logFile(def.name);
    const logFd = openSync(logFile, 'a');
    try {
      if (def.prepare) {
        on({ type: 'prepare', name: def.name });
        const code = await runShell(def, def.prepare, logFd);
        if (code !== 0) throw new ServiceError(`${def.name}: prepare step failed (exit ${code}); see ${logFile}`);
      }
      // detached: the service gets its own process group (so `down` can stop its children too) and outlives us.
      const child = spawn('sh', ['-c', def.command], { cwd, env: { ...process.env, ...def.env }, stdio: ['ignore', logFd, logFd], detached: true });
      child.once('error', () => {});
      if (!child.pid) throw new ServiceError(`${def.name}: could not start the process`);
      child.unref();
      this.store.setRunning(def.name, { pid: child.pid, startedAt: new Date().toISOString() });
      on({ type: 'start', name: def.name, pid: child.pid, logFile });
    } finally {
      closeSync(logFd);
    }
  }

  private async waitReady(def: ServiceDef, on: (e: ServiceEvent) => void): Promise<void> {
    const began = Date.now();
    const deadline = began + (def.startTimeoutSec ?? 120) * 1000;
    while (Date.now() < deadline) {
      const rec = this.store.running()[def.name];
      if (await portOpen(def.port)) return on({ type: 'ready', name: def.name, seconds: Math.round((Date.now() - began) / 1000) });
      if (!rec || !isAlive(rec.pid)) {
        this.store.setRunning(def.name, null);
        throw new ServiceError(`${def.name} exited before it opened port ${def.port}; see ${this.store.logFile(def.name)}`);
      }
      await sleep(500);
    }
    throw new ServiceError(`${def.name} did not open port ${def.port} within ${def.startTimeoutSec ?? 120}s; it may still be starting — see ${this.store.logFile(def.name)}`);
  }

  /**
   * Stops the named services and what depends on them, then starts back everything that was
   * actually stopped, in its original order. Dependencies of those services are left alone unless
   * they are down.
   */
  async restart(names: string[], on: (e: ServiceEvent) => void = () => {}): Promise<void> {
    const stopped: string[] = [];
    await this.down(
      names,
      (e) => {
        if (e.type === 'stopped') stopped.push(e.name);
        on(e);
      },
      { external: true },
    );
    // a service that was not running is still started: restarting means "have it running afterwards"
    const wanted = new Set([...this.resolve(names), ...stopped]);
    const sequence = [...this.order([...wanted])].map((d) => d.name).filter((n) => wanted.has(n));
    await this.up(sequence, on);
  }

  /**
   * Switches the git checkout a service runs from to `branch` (stash → checkout → pull → pop, the
   * same engine as the Repos tab) and, if the service was running, starts it again on the new code.
   * The service is stopped first so nothing runs against a half-switched tree; if the switch fails
   * it is left stopped. A switch that was cancelled before changing anything restores it.
   * Questions the engine would ask (create the branch? remove a worktree?) are answered "no".
   */
  async switchBranch(
    name: string,
    branch: string,
    opts: { restart?: boolean; onStep?: (e: StepEvent) => void; on?: (e: ServiceEvent) => void } = {},
  ): Promise<{ result: RunResult; restarted: boolean }> {
    const def = this.store.get(name);
    const git = await serviceGit(def.cwd);
    if (!git) throw new ServiceError(`${name}: ${def.cwd} is not inside a git repository`);
    const on = opts.on ?? (() => {});
    const [before] = await this.status(name);
    const wasRunning = before!.state !== 'down';
    const stopped: string[] = [];
    if (wasRunning && opts.restart !== false) {
      await this.down([name], (e) => (e.type === 'stopped' && stopped.push(e.name), on(e)), { external: true });
    }
    const result = await switchBranch(git.root, branch, {}, async () => false, opts.onStep);
    if (result.outcome === 'failed') return { result, restarted: false };
    if (stopped.length && (result.outcome === 'switched' || result.outcome === 'cancelled')) {
      const wanted = new Set(stopped);
      await this.up(this.order([...wanted]).map((d) => d.name).filter((n) => wanted.has(n)), on);
      return { result, restarted: true };
    }
    return { result, restarted: false };
  }

  /**
   * Stops services and whatever depends on them, dependents first. Always stops what the helper
   * started. With `external`, also stops a process something else started (an IDE, a terminal) —
   * only the one process listening on the service's port, never its parent or process group.
   */
  async down(names: string[], on: (e: ServiceEvent) => void = () => {}, opts: { external?: boolean } = {}): Promise<void> {
    const all = this.store.list();
    const wanted = new Set(names.length ? this.resolve(names) : all.map((s) => s.name));
    // also stop anything that depends on a service being stopped
    for (let grew = true; grew; ) {
      grew = false;
      for (const s of all) if (!wanted.has(s.name) && (s.dependsOn ?? []).some((d) => wanted.has(d))) wanted.add(s.name), (grew = true);
    }
    // order() also lists each service's dependencies; those are not ours to stop, only what was asked for and its dependents
    const stopOrder = this.order([...wanted]).filter((d) => wanted.has(d.name)).reverse();
    for (const def of stopOrder) {
      const rec = this.store.running()[def.name];
      if (rec && isAlive(rec.pid)) {
        await this.kill(rec.pid, true);
        this.store.setRunning(def.name, null);
        on({ type: 'stopped', name: def.name });
        continue;
      }
      this.store.setRunning(def.name, null);
      const [st] = await this.status(def.name);
      if (st!.state === 'external' && opts.external && st!.externalPid) {
        await this.kill(st!.externalPid, false);
        on({ type: 'stopped', name: def.name, external: true });
      } else {
        on({ type: 'skip', name: def.name, reason: st!.state === 'external' ? `running outside tidy (pid ${st!.externalPid}) — stop it explicitly: services down ${def.name}` : 'not running' });
      }
    }
  }

  /** `group`: signal the whole process group (ours: sh/mvn wrappers and the JVM). Otherwise only `pid`. */
  private async kill(pid: number, group: boolean): Promise<void> {
    const signal = (sig: NodeJS.Signals) => {
      try {
        process.kill(group ? -pid : pid, sig);
      } catch {
        try {
          process.kill(pid, sig);
        } catch {
          /* already gone */
        }
      }
    };
    signal('SIGTERM');
    for (let i = 0; i < 60 && isAlive(pid); i++) await sleep(250);
    if (isAlive(pid)) signal('SIGKILL');
  }

  /** Last `lines` lines of a service's log. */
  tail(name: string, lines = 50): string {
    this.store.get(name);
    try {
      const all = readFileSync(this.store.logFile(name), 'utf8').split('\n');
      return all.slice(-lines - 1).join('\n');
    } catch {
      return '';
    }
  }
}
