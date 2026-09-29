import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { History, Registry, RegistryError, inspect, switchBranch } from '../src/index.js';
import { makeFixture, scripted } from './fixture.js';

const tempFile = (name: string) => join(mkdtempSync(join(tmpdir(), 'git-helper-reg-')), name);

describe('Registry', () => {
  it('adds by any inner path, rejects duplicates, finds by name/id/path, removes from groups', async () => {
    const a = makeFixture();
    const b = makeFixture();
    const reg = new Registry(tempFile('repos.json'));
    const ea = await reg.add(a.work, { name: 'api', base: 'origin/main' });
    const eb = await reg.add(b.work, { name: 'web' });
    await expect(reg.add(a.work)).rejects.toThrow(RegistryError);
    await expect(reg.add(b.other, { name: 'api' })).rejects.toThrow(/already registered/);
    await expect(reg.add(a.dir)).rejects.toThrow(/not inside a git work tree/);
    expect(reg.find('api')?.id).toBe(ea.id);
    expect(reg.find(eb.id)?.name).toBe('web');
    expect(reg.find(join(a.work, 'shared.txt'))?.name).toBe('api');
    reg.setGroup('work', ['api', 'web']);
    expect(reg.groupRepos('work').map((r) => r.name)).toEqual(['api', 'web']);
    reg.update('api', { base: '' });
    expect(reg.find('api')?.base).toBeUndefined();
    reg.remove('api');
    expect(reg.groupRepos('work').map((r) => r.name)).toEqual(['web']);
    expect(reg.list()).toHaveLength(1);
  });
});

describe('History', () => {
  it('appends results and lists newest first, filtered by repo', async () => {
    const fx = makeFixture();
    const history = new History(tempFile('history.jsonl'));
    history.append(await switchBranch(fx.work, 'feature', {}, scripted()));
    history.append(await switchBranch(fx.work, 'main', {}, scripted()));
    const all = history.list();
    expect(all.map((e) => e.to)).toEqual(['main', 'feature']);
    expect(all[0]!.steps.length).toBeGreaterThan(0);
    expect(history.list({ repo: '/elsewhere' })).toEqual([]);
    expect(history.list({ limit: 1 })).toHaveLength(1);
  });
});

describe('inspect', () => {
  it('reports branch, counts, upstream and worktrees', async () => {
    const fx = makeFixture();
    fx.write(fx.work, 'shared.txt', 'x');
    fx.write(fx.work, 'u1.txt', 'x');
    fx.commit(fx.other, 'shared.txt', 'upstream');
    const s = await inspect(join(fx.work));
    expect(s).toMatchObject({ branch: 'main', upstream: 'origin/main', uncommitted: 1, untracked: 1, inProgress: 'none' });
    expect(s.worktrees).toHaveLength(1);
    expect(s.worktrees[0]!.isMain).toBe(true);
  });
});
