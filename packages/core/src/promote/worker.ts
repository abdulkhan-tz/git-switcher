import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configDir } from '../paths.js';
import { Registry } from '../registry/registry.js';
import { SettingsStore } from '../settings.js';
import { advance, createPromotion, PromotionError, resumed } from './engine.js';
import { GhClient, type GitHubClient } from './github.js';
import { PromotionStore } from './store.js';
import type { Promotion, PromotionEvent } from './types.js';

export interface WorkerOptions {
  store?: PromotionStore;
  registry?: Registry;
  github?: GitHubClient;
  settings?: SettingsStore;
  /** Fixed poll interval (tests, --poll). Otherwise read from settings before every wait. */
  intervalMs?: number;
  lockFile?: string;
  now?: () => Date;
}

export interface WorkerStatus {
  /** This process is the one polling. */
  polling: boolean;
  /** Checks are switched off in settings; no GitHub calls are made. */
  paused: boolean;
  /** PID of the polling process, if any is alive. */
  holder: number | null;
  intervalMs: number;
  /** ISO time of the next scheduled check, as published by the polling process. */
  nextCheckAt: string | null;
  lastCheckAt: string | null;
  checking: boolean;
}

interface LockInfo {
  pid: number;
  paused?: boolean;
  intervalMs?: number;
  nextCheckAt?: string | null;
  lastCheckAt?: string | null;
}

/** While paused, how often the polling process re-reads settings to notice it was switched back on. */
const PAUSED_RECHECK_MS = 3000;

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
 * shared store); only the process holding the lock polls them, and it publishes its schedule in
 * the lock file so every dashboard can show a countdown.
 */
export class PromotionWorker {
  readonly store: PromotionStore;
  readonly registry: Registry;
  readonly github: GitHubClient;
  readonly settings: SettingsStore;
  private readonly fixedIntervalMs: number | undefined;
  private readonly lockFile: string;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;
  private owner = false;
  private nextCheckAt: string | null = null;
  private lastCheckAt: string | null = null;
  private listeners = new Set<(e: PromotionEvent) => void>();
  private releaseOnExit = () => this.releaseLock();

  constructor(opts: WorkerOptions = {}) {
    this.store = opts.store ?? new PromotionStore();
    this.registry = opts.registry ?? new Registry();
    this.github = opts.github ?? new GhClient();
    this.settings = opts.settings ?? new SettingsStore();
    this.fixedIntervalMs = opts.intervalMs;
    this.lockFile = opts.lockFile ?? join(configDir(), 'worker.lock');
    this.now = opts.now ?? (() => new Date());
  }

  get paused(): boolean {
    return !this.settings.load().promotionChecksEnabled;
  }

  get intervalMs(): number {
    return this.fixedIntervalMs ?? this.settings.load().promotionIntervalSec * 1000;
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

  private readLock(): LockInfo | null {
    if (!existsSync(this.lockFile)) return null;
    const raw = readFileSync(this.lockFile, 'utf8').trim();
    try {
      const info = raw.startsWith('{') ? (JSON.parse(raw) as LockInfo) : { pid: Number(raw) };
      return Number.isInteger(info.pid) && info.pid > 0 && pidAlive(info.pid) ? info : null;
    } catch {
      return null;
    }
  }

  /** Who holds the lock: this process, another live PID, or nobody. */
  lockHolder(): number | null {
    return this.readLock()?.pid ?? null;
  }

  private writeLock(): void {
    mkdirSync(dirname(this.lockFile), { recursive: true });
    const info: LockInfo = { pid: process.pid, paused: this.paused, intervalMs: this.intervalMs, nextCheckAt: this.nextCheckAt, lastCheckAt: this.lastCheckAt };
    writeFileSync(this.lockFile, JSON.stringify(info));
  }

  private acquireLock(): boolean {
    const holder = this.lockHolder();
    if (holder !== null && holder !== process.pid) return false;
    this.writeLock();
    return true;
  }

  private releaseLock(): void {
    try {
      if (this.readLock()?.pid === process.pid) unlinkSync(this.lockFile);
    } catch {
      /* best effort */
    }
  }

  /** Starts polling if no other live process is. Returns whether this process now owns the worker. */
  start(): boolean {
    if (this.owner) return true;
    this.owner = this.acquireLock();
    if (!this.owner) return false;
    process.once('exit', this.releaseOnExit);
    if (this.paused) this.schedule();
    else void this.tick().then(() => this.schedule());
    return true;
  }

  /** (Re)arms the timer for one interval from now and publishes when that is. */
  private schedule(): void {
    if (!this.owner) return;
    if (this.timer) clearTimeout(this.timer);
    // Paused: no GitHub calls, only a cheap look at settings now and then so switching checks back
    // on (from any git-tidy process) takes effect within seconds.
    const paused = this.paused;
    const ms = paused ? PAUSED_RECHECK_MS : this.intervalMs;
    this.nextCheckAt = paused ? null : new Date(this.now().getTime() + ms).toISOString();
    this.writeLock();
    this.timer = setTimeout(() => {
      // Hand over gracefully if another process took the lock.
      if (!this.acquireLock()) return this.stop();
      if (this.paused) return this.schedule();
      if (paused) this.schedule(); // just switched back on: start a full interval, not an instant check
      else void this.tick().then(() => this.schedule());
    }, ms);
    this.timer.unref?.();
  }

  /** Switches GitHub checks on or off for every git-tidy process. */
  setChecksEnabled(enabled: boolean): boolean {
    this.settings.update({ promotionChecksEnabled: enabled });
    this.schedule();
    return enabled;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.owner) this.releaseLock();
    this.owner = false;
    this.nextCheckAt = null;
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
      this.lastCheckAt = this.now().toISOString();
      if (this.owner) this.writeLock();
    });
    return this.ticking;
  }

  /** Checks right away and, when polling, restarts the countdown. */
  async checkNow(): Promise<void> {
    await this.tick();
    this.schedule();
  }

  /** Saves a new interval (1–60 s); the polling process picks it up at once. */
  setIntervalSec(sec: number): number {
    const saved = this.settings.update({ promotionIntervalSec: sec }).promotionIntervalSec;
    this.schedule();
    return saved;
  }

  status(): WorkerStatus {
    const lock = this.readLock();
    return {
      polling: this.owner,
      paused: this.paused,
      holder: lock?.pid ?? null,
      intervalMs: this.owner ? this.intervalMs : (lock?.intervalMs ?? this.intervalMs),
      nextCheckAt: this.owner ? this.nextCheckAt : (lock?.nextCheckAt ?? null),
      lastCheckAt: this.owner ? this.lastCheckAt : (lock?.lastCheckAt ?? null),
      checking: this.ticking !== undefined,
    };
  }

  private async advanceAndSave(p: Promotion): Promise<Promotion> {
    const next = await advance(p, this.github, this.emit, this.now);
    // A stop (or delete) written by another process while we were talking to GitHub wins.
    const latest = this.store.get(p.id);
    if (!latest) return next;
    if (latest.status === 'stopped' && next.status === 'running') next.status = 'stopped';
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

  /** Removes a finished promotion from the list. Its PRs on GitHub are not touched. */
  deletePromotion(id: string): Promotion {
    const p = this.store.get(id);
    if (!p) throw new PromotionError(`no promotion "${id}"`);
    if (p.status === 'running') throw new PromotionError(`promotion ${p.id} is running; stop it before deleting it`);
    this.store.remove(p.id);
    return p;
  }

  /** Removes every promotion that is not running. Returns how many were removed. */
  clearFinished(): number {
    const finished = this.store.list().filter((p) => p.status !== 'running');
    for (const p of finished) this.store.remove(p.id);
    return finished.length;
  }
}
