import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { canonical, repoRoot } from '../inspect/inspect.js';
import { configDir } from '../paths.js';

export interface RepoEntry {
  id: string;
  name: string;
  path: string;
  /** Start point for branches that do not exist yet, e.g. `origin/develop`. */
  base?: string;
  remote?: string;
}

export interface Group {
  name: string;
  repoIds: string[];
}

export interface RegistryData {
  version: 1;
  repos: RepoEntry[];
  groups: Group[];
}

export class RegistryError extends Error {}

export class Registry {
  constructor(readonly file: string = join(configDir(), 'repos.json')) {}

  load(): RegistryData {
    if (!existsSync(this.file)) return { version: 1, repos: [], groups: [] };
    const data = JSON.parse(readFileSync(this.file, 'utf8')) as RegistryData;
    return { version: 1, repos: data.repos ?? [], groups: data.groups ?? [] };
  }

  private save(data: RegistryData): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    renameSync(tmp, this.file);
  }

  list(): RepoEntry[] {
    return this.load().repos;
  }

  async add(path: string, opts: { name?: string; base?: string; remote?: string } = {}): Promise<RepoEntry> {
    const root = await repoRoot(resolve(path)).catch(() => {
      throw new RegistryError(`${path} is not inside a git work tree`);
    });
    const data = this.load();
    const name = opts.name ?? basename(root);
    const byPath = data.repos.find((r) => r.path === root);
    if (byPath) throw new RegistryError(`${root} is already registered as "${byPath.name}"`);
    if (data.repos.some((r) => r.name === name)) throw new RegistryError(`a repo named "${name}" is already registered; pass a different name`);
    const entry: RepoEntry = { id: randomBytes(4).toString('hex'), name, path: root };
    if (opts.base) entry.base = opts.base;
    if (opts.remote) entry.remote = opts.remote;
    data.repos.push(entry);
    this.save(data);
    return entry;
  }

  update(ref: string, patch: Partial<Pick<RepoEntry, 'name' | 'base' | 'remote'>>): RepoEntry {
    const data = this.load();
    const entry = this.find(ref, data);
    if (!entry) throw new RegistryError(`no registered repo "${ref}"`);
    if (patch.name && patch.name !== entry.name && data.repos.some((r) => r.name === patch.name)) {
      throw new RegistryError(`a repo named "${patch.name}" is already registered`);
    }
    if (patch.name) entry.name = patch.name;
    // An empty string clears an optional setting.
    for (const key of ['base', 'remote'] as const) {
      if (patch[key] === undefined) continue;
      if (patch[key] === '') delete entry[key];
      else entry[key] = patch[key];
    }
    this.save(data);
    return entry;
  }

  remove(ref: string): RepoEntry {
    const data = this.load();
    const entry = this.find(ref, data);
    if (!entry) throw new RegistryError(`no registered repo "${ref}"`);
    data.repos = data.repos.filter((r) => r.id !== entry.id);
    for (const g of data.groups) g.repoIds = g.repoIds.filter((id) => id !== entry.id);
    this.save(data);
    return entry;
  }

  /** Looks a repo up by id, name, or path (any path inside it). */
  find(ref: string, data = this.load()): RepoEntry | undefined {
    const byKey = data.repos.find((r) => r.id === ref || r.name === ref);
    if (byKey) return byKey;
    const path = canonical(resolve(ref));
    return data.repos.find((r) => path === r.path || path.startsWith(r.path + '/'));
  }

  /** The registered repo whose top level is exactly `root`, if any. */
  byRoot(root: string): RepoEntry | undefined {
    return this.load().repos.find((r) => r.path === root);
  }

  groups(): Group[] {
    return this.load().groups;
  }

  setGroup(name: string, repoRefs: string[]): Group {
    const data = this.load();
    const repoIds = repoRefs.map((ref) => {
      const entry = this.find(ref, data);
      if (!entry) throw new RegistryError(`no registered repo "${ref}"`);
      return entry.id;
    });
    const group = { name, repoIds: [...new Set(repoIds)] };
    data.groups = [...data.groups.filter((g) => g.name !== name), group];
    this.save(data);
    return group;
  }

  removeGroup(name: string): void {
    const data = this.load();
    if (!data.groups.some((g) => g.name === name)) throw new RegistryError(`no group "${name}"`);
    data.groups = data.groups.filter((g) => g.name !== name);
    this.save(data);
  }

  groupRepos(name: string): RepoEntry[] {
    const data = this.load();
    const group = data.groups.find((g) => g.name === name);
    if (!group) throw new RegistryError(`no group "${name}"`);
    return group.repoIds.map((id) => data.repos.find((r) => r.id === id)).filter((r): r is RepoEntry => !!r);
  }
}

export function repoExists(entry: RepoEntry): boolean {
  return existsSync(entry.path);
}
