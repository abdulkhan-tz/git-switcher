import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PromotionStore, PromotionWorker, Registry, RegistryError, createPromotion, type PromotionEvent } from '../src/index.js';
import { makeFixture } from './fixture.js';
import { FakeGitHub } from './fakeGithub.js';

const STAGES = ['develop', 'qa', 'stage', 'main'];

async function setup(branches: Record<string, string[]>, autoMerge?: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'git-helper-promo-'));
  const fx = makeFixture();
  const registry = new Registry(join(dir, 'repos.json'));
  const repo = await registry.add(fx.work, { name: 'api' });
  registry.setPipeline('api', { stages: STAGES, autoMerge });
  const github = new FakeGitHub(branches);
  const store = new PromotionStore(join(dir, 'promotions.json'));
  const events: PromotionEvent[] = [];
  const make = () => {
    const w = new PromotionWorker({ store, registry, github, lockFile: join(dir, 'worker.lock'), intervalMs: 3_600_000 });
    w.on((e) => events.push(e));
    return w;
  };
  return { dir, registry, repo, github, store, events, worker: make(), make };
}

const base = { main: ['a'], stage: ['a'], qa: ['a'], develop: ['a', 'b', 'c'] };
const statuses = (p: { steps: { status: string }[] }) => p.steps.map((s) => s.status);

describe('pipeline config', () => {
  it('validates stages and auto-merge steps', async () => {
    const { registry } = await setup(base);
    expect(() => registry.setPipeline('api', { stages: ['develop'] })).toThrow(RegistryError);
    expect(() => registry.setPipeline('api', { stages: ['a', 'a'] })).toThrow(/unique/);
    expect(() => registry.setPipeline('api', { stages: ['a', 'b', 'c'], autoMerge: ['a→c'] })).toThrow(/not in the pipeline/);
    expect(registry.setPipeline('api', { stages: [' a ', 'b'], autoMerge: ['a→b'] }).pipeline).toEqual({ stages: ['a', 'b'], autoMerge: ['a→b'] });
    expect(registry.setPipeline('api', null).pipeline).toBeUndefined();
  });

  it('createPromotion honours --from and rejects bad starts', async () => {
    const { repo, registry } = await setup(base);
    const r = registry.find('api')!;
    expect(createPromotion(r, { from: 'qa' }).steps.map((s) => `${s.from}→${s.to}`)).toEqual(['qa→stage', 'stage→main']);
    expect(() => createPromotion(r, { from: 'main' })).toThrow(/last stage/);
    expect(() => createPromotion(r, { from: 'nope' })).toThrow(/not a stage/);
    expect(() => createPromotion({ ...repo, pipeline: undefined })).toThrow(/no pipeline/);
  });
});

describe('promotion run', () => {
  it('walks develop → qa → stage → main, one PR at a time, as each is merged', async () => {
    const { worker, github, events, store } = await setup(base);
    let p = await worker.startPromotion('api');
    expect(statuses(p)).toEqual(['open', 'pending', 'pending']);
    expect(p.steps[0]!.pr).toEqual({ number: 1, url: 'https://github.com/acme/api/pull/1' });
    expect(github.pr(1)).toMatchObject({ base: 'qa', head: 'develop', title: 'Promote develop → qa' });
    expect(github.pr(1).body).toContain('- commit b');

    await worker.tick();
    expect(statuses(store.get(p.id)!)).toEqual(['open', 'pending', 'pending']); // still waiting

    github.merge(1);
    await worker.tick();
    p = store.get(p.id)!;
    expect(statuses(p)).toEqual(['merged', 'open', 'pending']);
    expect(github.pr(2)).toMatchObject({ base: 'stage', head: 'qa' });

    github.merge(2);
    await worker.tick();
    github.merge(3);
    await worker.tick();
    p = store.get(p.id)!;
    expect(p.status).toBe('done');
    expect(statuses(p)).toEqual(['merged', 'merged', 'merged']);
    expect(events.filter((e) => e.type === 'pr-opened').map((e) => (e as any).step.pr.number)).toEqual([1, 2, 3]);
  });

  it('skips steps with nothing to promote', async () => {
    const { worker, github } = await setup({ main: ['a'], stage: ['a'], qa: ['a', 'b'], develop: ['a', 'b'] });
    const p = await worker.startPromotion('api');
    expect(statuses(p)).toEqual(['skipped', 'open', 'pending']);
    expect(github.pr(1)).toMatchObject({ base: 'stage', head: 'qa' });
  });

  it('finishes immediately when every stage is already up to date', async () => {
    const { worker, github } = await setup({ main: ['a'], stage: ['a'], qa: ['a'], develop: ['a'] });
    const p = await worker.startPromotion('api');
    expect(p.status).toBe('done');
    expect(github.prs).toHaveLength(0);
  });

  it('reuses an open PR instead of opening a duplicate', async () => {
    const { worker, github } = await setup(base);
    await github.createPr('acme/api', { base: 'qa', head: 'develop', title: 'mine', body: '' });
    const p = await worker.startPromotion('api');
    expect(github.prs).toHaveLength(1);
    expect(p.steps[0]!.message).toContain('reused open PR #1');
  });

  it('--from qa starts mid-chain', async () => {
    const { worker, github } = await setup({ ...base, qa: ['a', 'b'] });
    const p = await worker.startPromotion('api', { from: 'qa' });
    expect(p.steps).toHaveLength(2);
    expect(github.pr(1)).toMatchObject({ base: 'stage', head: 'qa' });
  });

  it('enables auto-merge only on configured steps; a failure to enable is recorded, not fatal', async () => {
    const { worker, github } = await setup(base, ['develop→qa']);
    github.autoMergeError = 'auto-merge is not allowed for this repository';
    const p = await worker.startPromotion('api');
    expect(p.status).toBe('running');
    expect(p.steps[0]!.message).toContain('auto-merge not enabled: auto-merge is not allowed');
    github.autoMergeError = null;
    github.merge(1);
    await worker.tick();
    expect(github.calls.filter((c) => c === 'enableAutoMerge')).toHaveLength(1); // qa→stage is manual
  });

  it('a PR closed without merging aborts; resuming after it is reopened continues', async () => {
    const { worker, github, store } = await setup(base);
    const p = await worker.startPromotion('api');
    github.close(1);
    await worker.tick();
    expect(store.get(p.id)).toMatchObject({ status: 'aborted', error: 'PR #1 was closed without merging' });
    github.reopen(1);
    github.merge(1);
    const r = await worker.resumePromotion(p.id);
    expect(statuses(r)).toEqual(['merged', 'open', 'pending']);
  });

  it('a GitHub error fails the promotion; resume retries the failed step', async () => {
    const { worker, github } = await setup(base);
    github.failNext.createPr = 'gh pr create failed: HTTP 502';
    const p = await worker.startPromotion('api');
    expect(p).toMatchObject({ status: 'failed', error: 'gh pr create failed: HTTP 502' });
    expect(p.steps[0]!.status).toBe('failed');
    const r = await worker.resumePromotion(p.id);
    expect(statuses(r)).toEqual(['open', 'pending', 'pending']);
  });

  it('stop halts polling without touching the PR; resume continues', async () => {
    const { worker, github, store } = await setup(base);
    const p = await worker.startPromotion('api');
    worker.stopPromotion(p.id);
    github.merge(1);
    await worker.tick();
    expect(store.get(p.id)!.status).toBe('stopped');
    expect(github.prs).toHaveLength(1);
    const r = await worker.resumePromotion(p.id);
    expect(statuses(r)).toEqual(['merged', 'open', 'pending']);
  });

  it('refuses a second running promotion for the same repo', async () => {
    const { worker } = await setup(base);
    await worker.startPromotion('api');
    await expect(worker.startPromotion('api')).rejects.toThrow(/already has a running promotion/);
  });

  it('an idle tick (nothing running) does not wedge later ticks', async () => {
    const { worker, github, store } = await setup(base);
    await worker.tick(); // nothing to do — used to leave a settled promise behind
    const p = await worker.startPromotion('api');
    github.merge(1);
    await worker.tick();
    expect(statuses(store.get(p.id)!)).toEqual(['merged', 'open', 'pending']);
  });

  it('a new worker (after a restart) picks up where the last one left off', async () => {
    const { worker, github, make, store } = await setup(base);
    const p = await worker.startPromotion('api');
    github.merge(1);
    const second = make();
    await second.tick();
    expect(statuses(store.get(p.id)!)).toEqual(['merged', 'open', 'pending']);
  });
});

describe('worker lock', () => {
  it('only one worker polls at a time; the lock is released on stop', async () => {
    const { make } = await setup(base);
    const a = make();
    const b = make();
    expect(a.start()).toBe(true);
    // Same process, so simulate another owner by checking the holder instead.
    expect(a.lockHolder()).toBe(process.pid);
    a.stop();
    expect(a.lockHolder()).toBeNull();
    expect(b.start()).toBe(true);
    b.stop();
  });

  it('does not poll while another live process holds the lock; takes over a stale lock', async () => {
    const { make, dir } = await setup(base);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'worker.lock'), String(process.ppid)); // a different, live process
    const w = make();
    expect(w.start()).toBe(false);
    expect(w.isOwner).toBe(false);
    writeFileSync(join(dir, 'worker.lock'), '999999'); // dead PID
    expect(w.start()).toBe(true);
    w.stop();
  });
});

describe('interval, countdown and deletion', () => {
  it('validates the 1–60 s interval and persists it', async () => {
    const { SettingsStore, SettingsError } = await import('../src/index.js');
    const dir = mkdtempSync(join(tmpdir(), 'git-helper-set-'));
    const settings = new SettingsStore(join(dir, 'settings.json'));
    expect(settings.load().promotionIntervalSec).toBe(60);
    expect(settings.update({ promotionIntervalSec: 5 }).promotionIntervalSec).toBe(5);
    expect(new SettingsStore(join(dir, 'settings.json')).load().promotionIntervalSec).toBe(5);
    for (const bad of [0, 61, 2.5, NaN]) expect(() => settings.update({ promotionIntervalSec: bad })).toThrow(SettingsError);
  });

  it('polls on its own at the configured interval and publishes the next check time', async () => {
    const { SettingsStore } = await import('../src/index.js');
    const { registry, github, store, dir } = await setup(base);
    const settings = new SettingsStore(join(dir, 'settings.json'));
    settings.update({ promotionIntervalSec: 1 });
    const w = new PromotionWorker({ store, registry, github, settings, lockFile: join(dir, 'lock2') });
    const p = await w.startPromotion('api');
    expect(w.start()).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    const s = w.status();
    expect(s).toMatchObject({ polling: true, intervalMs: 1000 });
    const inMs = new Date(s.nextCheckAt!).getTime() - Date.now();
    expect(inMs).toBeGreaterThan(500);
    expect(inMs).toBeLessThanOrEqual(1000);
    // Another process sees the same schedule through the lock file.
    const observer = new PromotionWorker({ store, registry, github, settings, lockFile: join(dir, 'lock2') });
    expect(observer.status()).toMatchObject({ polling: false, holder: process.pid, nextCheckAt: s.nextCheckAt });
    github.merge(1);
    await new Promise((r) => setTimeout(r, 1300)); // the timer, not a manual tick, moves it on
    expect(store.get(p.id)!.steps.map((x) => x.status)).toEqual(['merged', 'open', 'pending']);
    // Changing the interval restarts the countdown at once.
    w.setIntervalSec(30);
    const later = new Date(w.status().nextCheckAt!).getTime() - Date.now();
    expect(later).toBeGreaterThan(29_000);
    w.stop();
    expect(observer.status().holder).toBeNull();
  });

  it('deletes finished promotions only', async () => {
    const { worker, github } = await setup(base);
    const running = await worker.startPromotion('api');
    expect(() => worker.deletePromotion(running.id)).toThrow(/stop it before deleting/);
    worker.stopPromotion(running.id);
    expect(worker.deletePromotion(running.id).id).toBe(running.id);
    expect(worker.store.list()).toHaveLength(0);
    github.branches.set('qa', [...github.branches.get('develop')!]);
    github.branches.set('stage', [...github.branches.get('develop')!]);
    github.branches.set('main', [...github.branches.get('develop')!]);
    await worker.startPromotion('api'); // nothing to promote → done
    const again = await worker.startPromotion('api');
    expect(again.status).toBe('done');
    expect(worker.clearFinished()).toBe(2);
  });
});
