import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configDir } from '../paths.js';
import { Registry } from '../registry/registry.js';
import { advance, createPromotion, PromotionError, resumed } from './engine.js';
import { GhClient, type GitHubClient } from './github.js';
import { PromotionStore } from './store.js';
import type { Promotion, PromotionEvent } from './types.js';

export interface WorkerOptions {
  store?: PromotionStore;
  registry?: Registry;
  github?: GitHubClient;
  /** Poll interval. Default 60 s. */
  intervalMs?: number;
  lockFile?: string;
  now?: () => Date;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Drives running promotions. Any process may start/stop/resume promotions (they go through the
 * shared store); only the process holding the lock polls them.
 */
export class PromotionWorker {
  readonly store: PromotionStore;
  readonly registry: Registry;
  readonly github: GitHubClient;
  readonly intervalMs: number;
  private readonly lockFile: string;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;
  private owner = false;
  private listeners = new Set<(e: PromotionEvent) => void>();
  private releaseOnExit = () => this.releaseLock();

  constructor(opts: WorkerOptions = {}) {
    this.store = opts.store ?? new PromotionStore();
    this.registry = opts.registry ?? new Registry();
    this.github = opts.github ?? new GhClient();
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.lockFile = opts.lockFile ?? join(configDir(), 'worker.lock');
    this.now = opts.now ?? (() => new Date());
  }

  on(listener: (e: PromotionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit = (e: PromotionEvent) => {
    for (const l of this.listeners) l(e);
  };

  get isOwner(): boolean {
    return this.owner;
  }

  /** Who holds the lock: this process, another live PID, or nobody. */
  lockHolder(): number | null {
    if (!existsSync(this.lockFile)) return null;
    const pid = Number(readFileSync(this.lockFile, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 && pidAlive(pid) ? pid : null;
  }

  private acquireLock(): boolean {
    const holder = this.lockHolder();
    if (holder !== null && holder !== process.pid) return false;
    mkdirSync(dirname(this.lockFile), { recursive: true });
    writeFileSync(this.lockFile, String(process.pid));
    return true;
  }

  private releaseLock(): void {
    try {
      if (existsSync(this.lockFile) && readFileSync(this.lockFile, 'utf8').trim() === String(process.pid)) unlinkSync(this.lockFile);
    } catch {
      /* best effort */
    }
  }

  /** Starts polling if no other live process is. Returns whether this process now owns the worker. */
  start(): boolean {
    if (this.timer) return this.owner;
    this.owner = this.acquireLock();
    if (!this.owner) return false;
    process.once('exit', this.releaseOnExit);
    void this.tick();
    this.timer = setInterval(() => {
      // Keep the lock fresh, and hand over gracefully if another process took it.
      if (!this.acquireLock()) return this.stop();
      void this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
    return true;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.owner) this.releaseLock();
    this.owner = false;
    process.off('exit', this.releaseOnExit);
  }

  /** Advances every running promotion once. Overlapping calls share one pass. */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    const pass = async () => {
      for (const p of this.store.list().filter((x) => x.status === 'running')) await this.advanceAndSave(p);
    };
    // Clear in .finally (always async): clearing inside `pass` would run before this assignment
    // when there is nothing to do, leaving a settled promise that turns every later tick into a no-op.
    this.ticking = pass().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  private async advanceAndSave(p: Promotion): Promise<Promotion> {
    const next = await advance(p, this.github, this.emit, this.now);
    // A stop written by another process while we were talking to GitHub wins over "running".
    const latest = this.store.get(p.id);
    if (latest && latest.status === 'stopped' && next.status === 'running') next.status = 'stopped';
    this.store.put(next);
    this.emit({ type: 'updated', promotion: next });
    return next;
  }

  /** Creates a promotion and takes it as far as it can go right away (usually: opens the first PR). */
  async startPromotion(repoRef: string, opts: { from?: string } = {}): Promise<Promotion> {
    const repo = this.registry.find(repoRef);
    if (!repo) throw new PromotionError(`no registered repo "${repoRef}"`);
    const active = this.store.list().find((p) => p.repoId === repo.id && p.status === 'running');
    if (active) throw new PromotionError(`${repo.name} already has a running promotion (${active.id}); stop it first`);
    const p = createPromotion(repo, { from: opts.from, now: this.now() });
    this.store.put(p);
    return this.advanceAndSave(p);
  }

  stopPromotion(id: string): Promotion {
    const p = this.store.get(id);
    if (!p) throw new PromotionError(`no promotion "${id}"`);
    if (p.status !== 'running') return p;
    p.status = 'stopped';
    p.updatedAt = this.now().toISOString();
    this.store.put(p);
    this.emit({ type: 'updated', promotion: p });
    return p;
  }

  async resumePromotion(id: string): Promise<Promotion> {
    const p = this.store.get(id);
    if (!p) throw new PromotionError(`no promotion "${id}"`);
    if (p.status === 'done') throw new PromotionError(`promotion ${p.id} is already done`);
    const next = resumed(p);
    this.store.put(next);
    return this.advanceAndSave(next);
  }
}
