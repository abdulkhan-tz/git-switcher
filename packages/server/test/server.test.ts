import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { History, Registry } from '@gsw/core';
import { startServer, type RunEvent, type RunningServer } from '../src/index.js';
import { makeFixture, sh } from '../../core/test/fixture.js';

let running: RunningServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'gsw-srv-'));
  const registry = new Registry(join(dir, 'repos.json'));
  running = await startServer({ registry, history: new History(join(dir, 'h.jsonl')), token: 'secret' });
  const base = `http://127.0.0.1:${running.port}`;
  const call = async (method: string, path: string, body?: unknown, token = 'secret') => {
    const res = await fetch(base + path, {
      method,
      headers: { 'x-gsw-token': token, 'content-type': 'application/json' },
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
      request({ host: '127.0.0.1', port: running!.port, path: '/api/repos', headers: { host: 'evil.example', 'x-gsw-token': 'secret' } }, (res) => ok(res.statusCode!)).end();
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
