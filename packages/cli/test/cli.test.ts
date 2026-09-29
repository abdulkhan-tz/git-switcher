import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { History, Registry } from '@git-helper/core';
import { main } from '../src/main.js';
import { parseArgs } from '../src/args.js';
import { makeFixture, sh } from '../../core/test/fixture.js';

function run(argv: string[], cwd: string, input = '', deps?: { registry: Registry; history: History }) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let text = '';
  stdout.on('data', (d) => (text += d));
  stdin.end(input);
  const dir = mkdtempSync(join(tmpdir(), 'git-helper-cli-'));
  const d = deps ?? { registry: new Registry(join(dir, 'repos.json')), history: new History(join(dir, 'history.jsonl')) };
  return main(argv, { stdin, stdout, cwd, color: false }, d).then((code) => ({ code, text, ...d }));
}

describe('parseArgs', () => {
  it('handles values, =values, booleans and --', () => {
    expect(parseArgs(['feat-1', '--group', 'work', '--no-open', '--base=origin/x', '--', '--weird'])).toEqual({
      positional: ['feat-1', '--weird'],
      flags: { group: 'work', 'no-open': true, base: 'origin/x' },
    });
  });
});

describe('git-helper', () => {
  it('switches the current repo from a subdirectory and records history; exit 0', async () => {
    const fx = makeFixture();
    fx.write(fx.work, 'shared.txt', 'wip\n');
    const { code, text, history } = await run(['feature'], fx.work);
    expect(code).toBe(0);
    expect(text).toContain('✓ stash');
    expect(text).toContain('on feature');
    expect(sh(fx.work, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature');
    expect(history.list()[0]).toMatchObject({ outcome: 'switched', to: 'feature' });
  });

  it('declining a prompt exits 2; EOF on stdin counts as "no"', async () => {
    const fx = makeFixture();
    expect((await run(['new-branch'], fx.work, 'n\n')).code).toBe(2);
    expect((await run(['new-branch'], fx.work, '')).code).toBe(2);
    expect(sh(fx.work, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  it('dirty worktree needs the literal word "yes"', async () => {
    const fx = makeFixture();
    const wt = join(fx.dir, 'wt');
    sh(fx.work, 'worktree', 'add', '-q', wt, 'feature');
    fx.write(wt, 'feature.txt', 'precious');
    const declined = await run(['feature'], fx.work, 'y\ny\n');
    expect(declined.code).toBe(2);
    expect(declined.text).toContain('DESTROYS');
    const accepted = await run(['feature'], fx.work, 'y\nyes\n');
    expect(accepted.code).toBe(0);
  });

  it('failure prints recovery and exits 1', async () => {
    const fx = makeFixture();
    fx.commit(fx.other, 'shared.txt', 'theirs\n');
    sh(fx.other, 'push', '-q');
    fx.commit(fx.work, 'shared.txt', 'ours\n');
    sh(fx.work, 'switch', '-q', 'feature');
    fx.write(fx.work, 'feature.txt', 'wip');
    const { code, text } = await run(['main'], fx.work);
    expect(code).toBe(1);
    expect(text).toContain('stopped at pull');
    expect(text).toContain('git stash pop stash@{0}');
  });

  it('registry commands and a group switch with a per-repo base', async () => {
    const a = makeFixture();
    const b = makeFixture();
    const first = await run(['add', a.work, '--name', 'api', '--base', 'origin/feature'], a.dir);
    const deps = { registry: first.registry, history: first.history };
    expect(first.code).toBe(0);
    expect((await run(['add', b.work, '--name', 'web'], b.dir, '', deps)).code).toBe(0);
    expect((await run(['group', 'add', 'work', 'api', 'web'], a.dir, '', deps)).code).toBe(0);
    const ls = await run(['ls'], a.dir, '', deps);
    expect(ls.text).toMatch(/api\s+main/);
    expect(ls.text).toContain('group work: api, web');

    const sw = await run(['feat-9', '--group', 'work'], a.dir, 'y\ny\n', deps);
    expect(sw.code).toBe(0);
    expect(sw.text).toContain('Create it from origin/feature?');
    expect(sw.text).toContain('Create it from origin/main?');
    expect(sw.text).toMatch(/Summary[\s\S]*api\s+switched[\s\S]*web\s+switched/);
    expect(a.exists(a.work, 'feature.txt')).toBe(true);

    const hist = await run(['history', '--repo', 'api'], a.dir, '', deps);
    expect(hist.text).toContain('main → feat-9');
    expect((await run(['rm', 'web'], a.dir, '', deps)).code).toBe(0);
    expect((await run(['rm', 'web'], a.dir, '', deps)).code).toBe(1);
  });

  it('`git-helper switch ls` switches to a branch literally named ls; no args prints usage with exit 1', async () => {
    const fx = makeFixture();
    fx.pushNewBranch('ls');
    expect((await run(['switch', 'ls'], fx.work)).code).toBe(0);
    const usage = await run([], fx.work);
    expect(usage.code).toBe(1);
    expect(usage.text).toContain('git helper —');
  });

  it('asks before repairing a branch stored with the wrong case', async () => {
    const { existsSync, writeFileSync, mkdtempSync: mk } = await import('node:fs');
    const probe = mk(join(tmpdir(), 'git-helper-ci-'));
    writeFileSync(join(probe, 'a'), '');
    if (!existsSync(join(probe, 'A'))) return; // case-sensitive disk: nothing folds
    const fx = makeFixture();
    fx.pushNewBranch('Ticket/old');
    fx.pushNewBranch('ticket/new');
    sh(fx.work, 'fetch', '-q');
    sh(fx.work, 'branch', 'Ticket/old', 'origin/Ticket/old');
    sh(fx.work, 'switch', '-q', '-c', 'ticket/new', '--track', 'origin/ticket/new'); // folds to Ticket/new
    const { code, text } = await run(['ticket/new'], fx.work, 'y\n');
    expect(text).toContain('is stored as "Ticket/new"');
    expect(text).toContain('renamed Ticket/new → ticket/new');
    expect(code).toBe(0);
    expect(sh(fx.work, 'for-each-ref', '--format=%(refname)', 'refs/heads/ticket/new')).toBe('refs/heads/ticket/new');
  });
});
