import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { History, PromotionStore, PromotionWorker, Registry } from '@git-helper/core';
import { main } from '../src/main.js';
import { makeFixture } from '../../core/test/fixture.js';
import { FakeGitHub } from '../../core/test/fakeGithub.js';

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'git-helper-pcli-'));
  const registry = new Registry(join(dir, 'repos.json'));
  const history = new History(join(dir, 'h.jsonl'));
  const fx = makeFixture();
  await registry.add(fx.work, { name: 'api' });
  const github = new FakeGitHub({ main: ['a'], stage: ['a'], qa: ['a'], develop: ['a', 'b'] });
  const worker = new PromotionWorker({ registry, github, store: new PromotionStore(join(dir, 'p.json')), lockFile: join(dir, 'lock'), intervalMs: 30 });
  const run = async (argv: string[]) => {
    const stdout = new PassThrough();
    let text = '';
    stdout.on('data', (d) => (text += d));
    const code = await main(argv, { stdin: new PassThrough(), stdout, cwd: dir, color: false }, { registry, history, promote: { worker, watchMs: 20 } });
    return { code, text };
  };
  return { run, github, worker };
}

describe('pipeline / promote / promotions', () => {
  it('sets and shows a pipeline, validating auto-merge steps', async () => {
    const { run } = await setup();
    expect((await run(['pipeline', 'set', 'api', 'develop', 'qa', 'stage', 'main', '--auto-merge', 'develop:qa'])).text).toContain('develop → qa → stage → main  auto-merge: develop→qa');
    expect((await run(['pipeline', 'set', 'api', 'develop', 'qa', '--auto-merge', 'qa:main'])).code).toBe(1);
    expect((await run(['pipeline', 'show'])).text).toMatch(/api\s+develop → qa → stage → main/);
  });

  it('promote opens the first PR and prints its link; promotions lists/stops/resumes', async () => {
    const { run, github, worker } = await setup();
    await run(['pipeline', 'set', 'api', 'develop', 'qa', 'stage', 'main']);
    const r = await run(['promote', 'api']);
    expect(r.code).toBe(0);
    expect(r.text).toContain('https://github.com/acme/api/pull/1');
    expect(r.text).toContain('waiting for merge');
    expect((await run(['promote', 'api'])).text).toContain('already has a running promotion');
    const id = worker.store.list()[0]!.id;
    expect((await run(['promotions', 'stop', id])).text).toContain('stopped');
    github.merge(1);
    const resumed = await run(['promotions', 'resume', id.slice(0, 4)]);
    expect(resumed.text).toContain('https://github.com/acme/api/pull/2');
    expect((await run(['promotions'])).text).toContain('No worker running');
  });

  it('--watch follows the chain to the end as PRs get merged', async () => {
    const { run, github } = await setup();
    await run(['pipeline', 'set', 'api', 'develop', 'qa', 'stage']);
    // Play the human: merge whatever is open, a little later each time.
    const merger = setInterval(() => github.prs.filter((p) => p.state === 'OPEN').forEach((p) => github.merge(p.number)), 40);
    const r = await run(['promote', 'api', '--watch']);
    clearInterval(merger);
    expect(r.code).toBe(0);
    expect(r.text).toContain('pull/2');
    expect(r.text).toMatch(/api\s+\w+\s+done/);
  });

  it('a promote with no pipeline fails clearly', async () => {
    const { run } = await setup();
    const r = await run(['promote', 'api']);
    expect(r.code).toBe(1);
    expect(r.text).toContain('has no pipeline');
  });
});

describe('interval and deletion commands', () => {
  it('promotions interval validates 1–60; rm/clear delete finished promotions', async () => {
    const { run, worker } = await setup();
    expect((await run(['promotions', 'interval', '61'])).code).toBe(1);
    expect((await run(['promotions', 'interval'])).text).toMatch(/every \d+s/);
    await run(['pipeline', 'set', 'api', 'develop', 'qa']);
    await run(['promote', 'api']);
    const id = worker.store.list()[0]!.id;
    expect((await run(['promotions', 'rm', id])).text).toContain('stop it before deleting');
    await run(['promotions', 'stop', id]);
    expect((await run(['promotions', 'rm', id.slice(0, 4)])).text).toContain('Deleted promotion');
    expect((await run(['promotions', 'clear'])).text).toContain('Deleted 0 finished');
  });
});

describe('promotions checks on|off', () => {
  it('pauses and resumes checks', async () => {
    const { run, worker } = await setup();
    expect((await run(['promotions', 'checks', 'off'])).text).toContain('checks are off');
    expect(worker.paused).toBe(true);
    expect((await run(['promotions'])).text).toContain('Promotion checks are off');
    expect((await run(['promotions', 'checks', 'maybe'])).code).toBe(1);
    expect((await run(['promotions', 'checks', 'on'])).text).toContain('checks are on');
    expect(worker.paused).toBe(false);
  });
});
