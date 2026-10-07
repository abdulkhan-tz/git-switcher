import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { configDir } from '../paths.js';
import type { ServiceDef } from './types.js';

export class ServiceError extends Error {}

export interface RunRecord {
  pid: number;
  startedAt: string;
}

interface Data {
  version: 1;
  services: ServiceDef[];
  /** What the helper itself started. Kept apart from the definitions so editing one never clobbers the other. */
  running: Record<string, RunRecord>;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

export function validateDef(raw: unknown): ServiceDef {
  const d = raw as Partial<ServiceDef> | null;
  if (!d || typeof d !== 'object') throw new ServiceError('a service must be an object');
  if (typeof d.name !== 'string' || !NAME.test(d.name)) throw new ServiceError(`invalid service name "${String(d.name)}" (letters, digits, . _ -)`);
  if (typeof d.cwd !== 'string' || !d.cwd) throw new ServiceError(`${d.name}: cwd is required`);
  if (typeof d.command !== 'string' || !d.command.trim()) throw new ServiceError(`${d.name}: command is required`);
  if (!Number.isInteger(d.port) || d.port! < 1 || d.port! > 65535) throw new ServiceError(`${d.name}: port must be 1-65535`);
  if (d.dependsOn !== undefined && !(Array.isArray(d.dependsOn) && d.dependsOn.every((x) => typeof x === 'string'))) throw new ServiceError(`${d.name}: dependsOn must be a list of names`);
  if (d.startTimeoutSec !== undefined && !(Number(d.startTimeoutSec) > 0)) throw new ServiceError(`${d.name}: startTimeoutSec must be positive`);
  return {
    name: d.name,
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
    if (!existsSync(this.file)) return { version: 1, services: [], running: {} };
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Data>;
      return { version: 1, services: data.services ?? [], running: data.running ?? {} };
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
    const i = data.services.findIndex((s) => s.name === def.name);
    if (i === -1) data.services.push(def);
    else data.services[i] = def;
    this.save(data);
    return i !== -1;
  }

  remove(name: string): ServiceDef {
    const data = this.load();
    const i = data.services.findIndex((s) => s.name === name);
    if (i === -1) throw new ServiceError(`no service "${name}"`);
    const [gone] = data.services.splice(i, 1);
    delete data.running[name];
    this.save(data);
    return gone!;
  }

  running(): Record<string, RunRecord> {
    return this.load().running;
  }

  setRunning(name: string, record: RunRecord | null): void {
    const data = this.load();
    if (record) data.running[name] = record;
    else delete data.running[name];
    this.save(data);
  }
}
