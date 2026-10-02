import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { History, Registry } from '@git-helper/core';
import { startServer, type RunEvent, type RunningServer } from '../src/index.js';
import { makeFixture, sh } from '../../core/test/fixture.js';

let running: RunningServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'git-helper-srv-'));
  const registry = new Registry(join(dir, 'repos.json'));
  running = await startServer({ registry, history: new History(join(dir, 'h.jsonl')), token: 'secret' });
  const base = `http://127.0.0.1:${running.port}`;
  const call = async (method: string, path: string, body?: unknown, token = 'secret') => {
    const res = await fetch(base + path, {
      method,
      headers: { 'x-git-helper-token': token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { registry, base, call };
}

/** Reads SSE events until `stop` returns true. */
async function readEvents(url: string, onEvent: (e: RunEvent) => Promise<void> | void, stop: (e: RunEvent) => boolean) {
  const res = await fetch(url);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const seen: RunEvent[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (!chunk.startsWith('data: ')) continue;
      const e = JSON.parse(chunk.slice(6)) as RunEvent;
      seen.push(e);
      await onEvent(e);
      if (stop(e)) {
        await reader.cancel();
        return seen;
      }
    }
  }
  return seen;
}

describe('server', () => {
  it('requires the token', async () => {
    const { call } = await boot();
    expect((await call('GET', '/api/repos', undefined, 'wrong')).status).toBe(401);
    expect((await call('GET', '/api/repos')).status).toBe(200);
  });

  it('rejects requests whose Host is not localhost', async () => {
    await boot();
    const status = await new Promise<number>((ok) => {
      request({ host: '127.0.0.1', port: running!.port, path: '/api/repos', headers: { host: 'evil.example', 'x-git-helper-token': 'secret' } }, (res) => ok(res.statusCode!)).end();
    });
    expect(status).toBe(403);
  });

  it('registers repos, groups them, and reports state and worktrees', async () => {
    const fx = makeFixture();
    const { call } = await boot();
    const added = await call('POST', '/api/repos', { path: fx.work, name: 'api', base: 'origin/feature' });
    expect(added.status).toBe(201);
    expect(added.body.state.branch).toBe('main');
    expect((await call('POST', '/api/repos', { path: fx.work })).status).toBe(400);
    expect((await call('PUT', '/api/groups/work', { repoIds: ['api'] })).body.repoIds).toEqual([added.body.id]);
    expect((await call('GET', `/api/repos/${added.body.id}/worktrees`)).body[0].isMain).toBe(true);
    expect((await call('PATCH', '/api/repos/ao', { base: '' })).body.base).toBeUndefined();
  });

  it('streams a switch, round-trips a prompt answer, rejects concurrent runs on a busy repo, and records history', async () => {
    const a = makeFixture();
    const b = makeFixture();
    const { call, base } = await boot();
    const ra = (await call('POST', '/api/repos', { path: a.work, name: 'a' })).body;
    const rb = (await call('POST', '/api/repos', { path: b.work, name: 'b' })).body;
    a.write(a.work, 'shared.txt', 'wip\n');

    const started = await call('POST', '/api/switch', { repoIds: [ra.id, rb.id], branch: 'feat-7' });
    expect(started.status).toBe(202);
    expect((await call('POST', '/api/switch', { repoIds: [ra.id], branch: 'x' })).status).toBe(409);

    const answers: boolean[] = [true, false]; // create in a, decline in b
    const events = await readEvents(
      `${base}/api/runs/${started.body.runId}/events?token=secret`,
      async (e) => {
        if (e.type === 'prompt') await call('POST', `/api/runs/${started.body.runId}/answer`, { promptId: e.promptId, answer: answers.shift() });
      },
      (e) => e.type === 'done',
    );
    const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    expect(done.results.map((r) => r.outcome)).toEqual(['switched', 'cancelled']);
    expect(sh(a.work, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat-7');
    expect(a.read(a.work, 'shared.txt')).toBe('wip\n');
    expect(events.filter((e) => e.type === 'answered')).toHaveLength(2);

    // A late subscriber gets the full replay.
    const replay = await readEvents(`${base}/api/runs/${started.body.runId}/events?token=secret`, () => {}, (e) => e.type === 'done');
    expect(replay.length).toBe(events.length);
    expect((await call('GET', '/api/history?repo=a')).body[0]).toMatchObject({ to: 'feat-7', outcome: 'switched' });
    // Repo is free again.
    expect((await call('POST', '/api/switch', { repoIds: [ra.id], branch: 'main' })).status).toBe(202);
  });

  it('cancel declines open prompts', async () => {
    const fx = makeFixture();
    const { call, base } = await boot();
    const r = (await call('POST', '/api/repos', { path: fx.work })).body;
    const { runId } = (await call('POST', '/api/switch', { repoIds: [r.id], branch: 'nope' })).body;
    const events = await readEvents(
      `${base}/api/runs/${runId}/events?token=secret`,
      async (e) => {
        if (e.type === 'prompt') await call('POST', `/api/runs/${runId}/cancel`);
      },
      (e) => e.type === 'done',
    );
    expect((events.at(-1) as any).results[0].outcome).toBe('cancelled');
  });
});

describe('promotions API', () => {
  it('sets a pipeline, starts a promotion, and follows merges via tick; stop/resume', async () => {
    const { PromotionStore, PromotionWorker } = await import('@git-helper/core');
    const { FakeGitHub } = await import('../../core/test/fakeGithub.js');
    const dir = mkdtempSync(join(tmpdir(), 'git-helper-srvp-'));
    const registry = new Registry(join(dir, 'repos.json'));
    const github = new FakeGitHub({ main: ['a'], qa: ['a'], develop: ['a', 'b'] });
    const worker = new PromotionWorker({ registry, github, store: new PromotionStore(join(dir, 'p.json')), lockFile: join(dir, 'lock') });
    running = await startServer({ registry, history: new History(join(dir, 'h.jsonl')), token: 't', worker, pollPromotions: false });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${running!.port}${path}`, { method, headers: { 'x-git-helper-token': 't', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as any };
    };
    const fx = makeFixture();
    const repo = (await call('POST', '/api/repos', { path: fx.work, name: 'api' })).body;
    expect((await call('PUT', `/api/repos/${repo.id}/pipeline`, { stages: ['develop'] })).status).toBe(400);
    expect((await call('PUT', `/api/repos/${repo.id}/pipeline`, { stages: ['develop', 'qa', 'main'], autoMerge: ['develop→qa'] })).body.pipeline.autoMerge).toEqual(['develop→qa']);

    const started = await call('POST', '/api/promotions', { repoIds: [repo.id] });
    expect(started.status).toBe(201);
    const id = started.body.started[0].id;
    expect(started.body.started[0].steps[0].pr.url).toContain('/pull/1');
    expect(github.pr(1).autoMerge).toBe(true);
    expect((await call('POST', '/api/promotions', { repoIds: [repo.id] })).body.errors[0].error).toContain('already has a running promotion');

    github.merge(1);
    await call('POST', '/api/promotions/tick');
    let list = (await call('GET', '/api/promotions')).body;
    expect(list.promotions[0].steps.map((s: any) => s.status)).toEqual(['merged', 'open']);
    expect(list.worker.polling).toBe(false);

    expect((await call('POST', `/api/promotions/${id}/stop`)).body.status).toBe('stopped');
    github.merge(2);
    expect((await call('POST', `/api/promotions/${id}/resume`)).body.status).toBe('done');
    expect((await call('POST', '/api/promotions/nope/stop')).status).toBe(400);
  });
});

describe('version', () => {
  it('reports whether the engine was rebuilt after the server started', async () => {
    const { call } = await boot();
    expect((await call('GET', '/api/version')).body).toEqual({ stale: false });
  });
});

describe('settings and deletion API', () => {
  it('sets the interval (1–60 s), deletes history and finished promotions', async () => {
    const { PromotionStore, PromotionWorker, SettingsStore } = await import('@git-helper/core');
    const { FakeGitHub } = await import('../../core/test/fakeGithub.js');
    const dir = mkdtempSync(join(tmpdir(), 'git-helper-srvs-'));
    const registry = new Registry(join(dir, 'repos.json'));
    const history = new History(join(dir, 'h.jsonl'));
    const github = new FakeGitHub({ main: ['a'], qa: ['a'], develop: ['a', 'b'] });
    const worker = new PromotionWorker({ registry, github, store: new PromotionStore(join(dir, 'p.json')), settings: new SettingsStore(join(dir, 's.json')), lockFile: join(dir, 'lock') });
    running = await startServer({ registry, history, token: 't', worker });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${running!.port}${path}`, { method, headers: { 'x-git-helper-token': 't', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as any };
    };
    expect((await call('PUT', '/api/settings', { promotionIntervalSec: 0 })).status).toBe(400);
    const set = await call('PUT', '/api/settings', { promotionIntervalSec: 7 });
    expect(set.body.settings.promotionIntervalSec).toBe(7);
    expect(set.body.worker).toMatchObject({ polling: true, intervalMs: 7000 });
    expect(new Date(set.body.worker.nextCheckAt).getTime() - Date.now()).toBeGreaterThan(6000);

    const fx = makeFixture();
    const repo = (await call('POST', '/api/repos', { path: fx.work, name: 'api' })).body;
    await call('PUT', `/api/repos/${repo.id}/pipeline`, { stages: ['develop', 'qa', 'main'] });
    const p = (await call('POST', '/api/promotions', { repoIds: [repo.id] })).body.started[0];
    expect((await call('DELETE', `/api/promotions/${p.id}`)).status).toBe(400);
    await call('POST', `/api/promotions/${p.id}/stop`);
    expect((await call('DELETE', '/api/promotions')).body.removed).toBe(1);

    const { switchBranch } = await import('@git-helper/core');
    const e1 = history.append(await switchBranch(fx.work, 'feature', {}, async () => false));
    history.append(await switchBranch(fx.work, 'main', {}, async () => false));
    expect((await call('DELETE', `/api/history/${e1.runId}`)).body.removed).toBe(1);
    expect((await call('DELETE', '/api/history/nope')).status).toBe(404);
    expect((await call('DELETE', '/api/history?repo=api')).body.removed).toBe(1);
    expect((await call('GET', '/api/history')).body).toEqual([]);
  });
});

describe('case repair API', () => {
  it('reports folded checkouts on the repo and repairs them', async () => {
    const { existsSync, writeFileSync, mkdtempSync: mk } = await import('node:fs');
    const probe = mk(join(tmpdir(), 'git-helper-ci-'));
    writeFileSync(join(probe, 'a'), '');
    if (!existsSync(join(probe, 'A'))) return; // case-sensitive disk: nothing folds
    const { call } = await boot();
    const fx = makeFixture();
    fx.pushNewBranch('ticket/a');
    sh(fx.work, 'fetch', '-q');
    sh(fx.work, 'branch', 'Ticket/other');
    sh(fx.work, 'switch', '-q', '-c', 'ticket/a', '--track', 'origin/ticket/a');
    sh(fx.work, 'pack-refs', '--all');
    const repo = (await call('POST', '/api/repos', { path: fx.work, name: 'api' })).body;
    expect(repo.folded).toEqual([expect.objectContaining({ head: 'ticket/a', stored: 'Ticket/a' })]);
    const fixed = (await call('POST', `/api/repos/${repo.id}/repair`)).body;
    expect(fixed.repaired).toHaveLength(1);
    expect(fixed.repo.folded).toEqual([]);
    expect(fixed.repo.state.branch).toBe('ticket/a');
  });
});
