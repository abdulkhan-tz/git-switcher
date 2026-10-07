import { execFile, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { connect } from 'node:net';
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

  async status(name?: string): Promise<ServiceStatus[]> {
    const defs = name ? [this.store.get(name)] : this.store.list();
    const running = this.store.running();
    return Promise.all(
      defs.map(async (d): Promise<ServiceStatus> => {
        const rec = running[d.name];
        const alive = rec ? isAlive(rec.pid) : false;
        if (rec && !alive) this.store.setRunning(d.name, null); // stale record: the process is gone
        const open = await portOpen(d.port);
        const base = { name: d.name, description: d.description, port: d.port, logFile: this.store.logFile(d.name), dependsOn: d.dependsOn ?? [] };
        if (alive && open) return { ...base, state: 'up', pid: rec!.pid, startedAt: rec!.startedAt };
        if (alive) return { ...base, state: 'starting', pid: rec!.pid, startedAt: rec!.startedAt };
        if (open) return { ...base, state: 'external', externalPid: await listeningPid(d.port) };
        return { ...base, state: 'down' };
      }),
    );
  }

  /** `names` plus everything they depend on, dependencies first. */
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
    const targets = names.length ? names : this.store.list().map((s) => s.name);
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

  /** Stops services the helper started. Processes started elsewhere are never touched. Dependents go first. */
  async down(names: string[], on: (e: ServiceEvent) => void = () => {}): Promise<void> {
    const all = this.store.list();
    const wanted = new Set(names.length ? names : all.map((s) => s.name));
    for (const n of wanted) this.store.get(n);
    // also stop anything that depends on a service being stopped
    for (let grew = true; grew; ) {
      grew = false;
      for (const s of all) if (!wanted.has(s.name) && (s.dependsOn ?? []).some((d) => wanted.has(d))) wanted.add(s.name), (grew = true);
    }
    const stopOrder = this.order([...wanted]).reverse();
    for (const def of stopOrder) {
      const rec = this.store.running()[def.name];
      if (!rec || !isAlive(rec.pid)) {
        this.store.setRunning(def.name, null);
        const [st] = await this.status(def.name);
        on({ type: 'skip', name: def.name, reason: st!.state === 'external' ? 'running outside git tidy — stop it where you started it' : 'not running' });
        continue;
      }
      await this.kill(rec.pid);
      this.store.setRunning(def.name, null);
      on({ type: 'stopped', name: def.name });
    }
  }

  private async kill(pid: number): Promise<void> {
    const signal = (sig: NodeJS.Signals) => {
      try {
        process.kill(-pid, sig); // the whole group: mvn/sh wrappers and the JVM
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
