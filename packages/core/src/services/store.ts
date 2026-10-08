import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { configDir } from '../paths.js';
import type { ServiceDef, ServiceGroup } from './types.js';

export class ServiceError extends Error {}

export interface RunRecord {
  pid: number;
  startedAt: string;
  /** Size of the log file when the process was started, so only this run's output is scanned for alerts. */
  logOffset?: number;
}

interface Data {
  version: 1;
  services: ServiceDef[];
  groups: ServiceGroup[];
  /** What the helper itself started. Kept apart from the definitions so editing one never clobbers the other. */
  running: Record<string, RunRecord>;
  /** The most recent start of each service, kept after it stops so its last log can still be checked for alerts. */
  lastRuns?: Record<string, RunRecord>;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Words the CLI or API gives a meaning of their own. */
const RESERVED = new Set(['groups', 'up', 'down', 'all']);

export function validName(name: unknown, what = 'service'): string {
  if (typeof name !== 'string' || !NAME.test(name)) throw new ServiceError(`invalid ${what} name "${String(name)}" (letters, digits, . _ -)`);
  if (RESERVED.has(name)) throw new ServiceError(`"${name}" is reserved; pick another ${what} name`);
  return name;
}

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

export function validateDef(raw: unknown): ServiceDef {
  const d = raw as Partial<ServiceDef> | null;
  if (!d || typeof d !== 'object') throw new ServiceError('a service must be an object');
  const name = validName(d.name);
  if (typeof d.cwd !== 'string' || !d.cwd) throw new ServiceError(`${d.name}: cwd is required`);
  if (typeof d.command !== 'string' || !d.command.trim()) throw new ServiceError(`${d.name}: command is required`);
  if (!Number.isInteger(d.port) || d.port! < 1 || d.port! > 65535) throw new ServiceError(`${d.name}: port must be 1-65535`);
  if (d.dependsOn !== undefined && !(Array.isArray(d.dependsOn) && d.dependsOn.every((x) => typeof x === 'string'))) throw new ServiceError(`${d.name}: dependsOn must be a list of names`);
  if (d.startTimeoutSec !== undefined && !(Number(d.startTimeoutSec) > 0)) throw new ServiceError(`${d.name}: startTimeoutSec must be positive`);
  return {
    name,
    description: typeof d.description === 'string' ? d.description : undefined,
    cwd: d.cwd,
    command: d.command,
    prepare: typeof d.prepare === 'string' && d.prepare.trim() ? d.prepare : undefined,
    port: d.port!,
    env: d.env && typeof d.env === 'object' ? Object.fromEntries(Object.entries(d.env).map(([k, v]) => [k, String(v)])) : undefined,
    dependsOn: d.dependsOn ?? [],
    startTimeoutSec: d.startTimeoutSec,
  };
}

/** Service definitions plus run records, shared by the CLI, dashboard and tray; always re-read before writing. */
export class ServiceStore {
  constructor(readonly file: string = join(configDir(), 'services.json')) {}

  get logDir(): string {
    return join(dirname(this.file), 'logs');
  }

  logFile(name: string): string {
    return join(this.logDir, `${name}.log`);
  }

  private load(): Data {
    if (!existsSync(this.file)) return { version: 1, services: [], groups: [], running: {} };
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Data>;
      return { version: 1, services: data.services ?? [], groups: data.groups ?? [], running: data.running ?? {}, lastRuns: data.lastRuns };
    } catch {
      throw new ServiceError(`${this.file} is not valid JSON — fix or delete it`);
    }
  }

  private save(data: Data): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    renameSync(tmp, this.file);
  }

  list(): ServiceDef[] {
    return this.load().services;
  }

  find(name: string): ServiceDef | undefined {
    return this.load().services.find((s) => s.name === name);
  }

  get(name: string): ServiceDef {
    const s = this.find(name);
    if (!s) throw new ServiceError(`no service "${name}" (see: services ls)`);
    return s;
  }

  /** Adds or replaces a definition. Returns true when it replaced one. */
  put(def: ServiceDef): boolean {
    const data = this.load();
    if (data.groups.some((g) => g.name === def.name)) throw new ServiceError(`"${def.name}" is already a group name`);
    const i = data.services.findIndex((s) => s.name === def.name);
    if (i === -1) data.services.push(def);
    else data.services[i] = def;
    this.save(data);
    return i !== -1;
  }

  /** Changes some fields of a definition: `undefined` leaves a field alone, `null` clears an optional one. The name is changed with `rename`. */
  update(name: string, patch: { [K in keyof Omit<ServiceDef, 'name'>]?: Omit<ServiceDef, 'name'>[K] | null }): ServiceDef {
    const merged: Record<string, unknown> = { ...this.get(name) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    const next = validateDef(merged);
    this.put(next);
    return next;
  }

  remove(name: string): ServiceDef {
    const data = this.load();
    const i = data.services.findIndex((s) => s.name === name);
    if (i === -1) throw new ServiceError(`no service "${name}"`);
    const needs = data.services.filter((s) => (s.dependsOn ?? []).includes(name)).map((s) => s.name);
    if (needs.length) throw new ServiceError(`${needs.join(', ')} depend${needs.length === 1 ? 's' : ''} on ${name}; change that first`);
    const [gone] = data.services.splice(i, 1);
    delete data.running[name];
    delete data.lastRuns?.[name];
    for (const g of data.groups) g.members = g.members.filter((m) => m !== name);
    this.save(data);
    return gone!;
  }

  /** Renames a service everywhere it is referenced: dependencies, groups, the run record and the log. */
  rename(from: string, to: string): ServiceDef {
    validName(to);
    const data = this.load();
    const def = data.services.find((s) => s.name === from);
    if (!def) throw new ServiceError(`no service "${from}"`);
    if (to === from) return def;
    if (data.services.some((s) => s.name === to) || data.groups.some((g) => g.name === to)) throw new ServiceError(`"${to}" is already in use`);
    def.name = to;
    for (const s of data.services) s.dependsOn = (s.dependsOn ?? []).map((d) => (d === from ? to : d));
    for (const g of data.groups) g.members = g.members.map((m) => (m === from ? to : m));
    if (data.running[from]) {
      data.running[to] = data.running[from]!;
      delete data.running[from];
    }
    if (data.lastRuns?.[from]) {
      data.lastRuns[to] = data.lastRuns[from]!;
      delete data.lastRuns[from];
    }
    const oldLog = this.logFile(from);
    if (existsSync(oldLog)) {
      try {
        renameSync(oldLog, this.logFile(to));
      } catch {
        /* keep going: the log is only a convenience */
      }
    }
    this.save(data);
    return def;
  }

  groups(): ServiceGroup[] {
    return this.load().groups;
  }

  /** Creates or replaces a group. `members` is the start sequence. */
  setGroup(name: string, members: string[]): ServiceGroup {
    validName(name, 'group');
    const data = this.load();
    if (data.services.some((s) => s.name === name)) throw new ServiceError(`"${name}" is already a service name`);
    if (members.length === 0) throw new ServiceError('a group needs at least one service');
    const unknown = members.filter((m) => !data.services.some((s) => s.name === m));
    if (unknown.length) throw new ServiceError(`no such service: ${unknown.join(', ')}`);
    const group = { name, members: [...new Set(members)] };
    const i = data.groups.findIndex((g) => g.name === name);
    if (i === -1) data.groups.push(group);
    else data.groups[i] = group;
    this.save(data);
    return group;
  }

  /** Renames a group, keeping its members and their order. */
  renameGroup(from: string, to: string): ServiceGroup {
    validName(to, 'group');
    const data = this.load();
    const g = data.groups.find((x) => x.name === from);
    if (!g) throw new ServiceError(`no group "${from}"`);
    if (to === from) return g;
    if (data.groups.some((x) => x.name === to) || data.services.some((s) => s.name === to)) throw new ServiceError(`"${to}" is already in use`);
    g.name = to;
    this.save(data);
    return g;
  }

  removeGroup(name: string): void {
    const data = this.load();
    const i = data.groups.findIndex((g) => g.name === name);
    if (i === -1) throw new ServiceError(`no group "${name}"`);
    data.groups.splice(i, 1);
    this.save(data);
  }

  running(): Record<string, RunRecord> {
    return this.load().running;
  }

  setRunning(name: string, record: RunRecord | null): void {
    const data = this.load();
    if (record) {
      data.running[name] = record;
      (data.lastRuns ??= {})[name] = record;
    } else delete data.running[name];
    this.save(data);
  }

  lastRun(name: string): RunRecord | undefined {
    return this.load().lastRuns?.[name];
  }
}
