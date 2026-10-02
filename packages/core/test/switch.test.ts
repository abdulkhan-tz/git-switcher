import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { findStash, switchBranch, switchMany } from '../src/index.js';
import { makeFixture, scripted, sh } from './fixture.js';

const stashList = (repo: string) => sh(repo, 'stash', 'list');
const branchOf = (repo: string) => sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD');

describe('switchBranch', () => {
  it('clean tree: switches without stashing and leaves an older unrelated stash untouched', async () => {
    const fx = makeFixture();
    fx.write(fx.work, 'shared.txt', 'old work\n');
    sh(fx.work, 'stash', 'push', '-m', 'unrelated');
    const r = await switchBranch(fx.work, 'feature', {}, scripted());
    expect(r.outcome).toBe('switched');
    expect(branchOf(fx.work)).toBe('feature');
    expect(r.stashMessage).toBeUndefined();
    expect(stashList(fx.work)).toContain('unrelated');
    expect(fx.read(fx.work, 'shared.txt')).toBe('base\n');
  });

  it('dirty tree: carries modified and untracked files to a remote-only branch', async () => {
    const fx = makeFixture();
    fx.write(fx.work, 'shared.txt', 'local edit\n');
    fx.write(fx.work, 'new.txt', 'untracked\n');
    const r = await switchBranch(fx.work, 'feature', {}, scripted());
    expect(r.outcome).toBe('switched');
    expect(branchOf(fx.work)).toBe('feature');
    expect(sh(fx.work, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/feature');
    expect(fx.read(fx.work, 'shared.txt')).toBe('local edit\n');
    expect(fx.read(fx.work, 'new.txt')).toBe('untracked\n');
    expect(r.stashRef).toBeUndefined();
    expect(stashList(fx.work)).toBe('');
  });

  it('pulls new upstream commits on an existing local branch', async () => {
    const fx = makeFixture();
    sh(fx.work, 'switch', '-q', 'feature');
    sh(fx.work, 'switch', '-q', 'main');
    sh(fx.other, 'switch', '-q', 'feature');
    fx.commit(fx.other, 'feature.txt', 'updated upstream');
    sh(fx.other, 'push', '-q');
    const r = await switchBranch(fx.work, 'feature', {}, scripted());
    expect(r.outcome).toBe('switched');
    expect(fx.read(fx.work, 'feature.txt')).toBe('updated upstream');
  });

  it('already on target: still stashes, pulls and pops', async () => {
    const fx = makeFixture();
    fx.commit(fx.other, 'shared.txt', 'upstream\n');
    sh(fx.other, 'push', '-q');
    fx.write(fx.work, 'mine.txt', 'wip');
    const r = await switchBranch(fx.work, 'main', {}, scripted());
    expect(r.outcome).toBe('switched');
    expect(r.events.find((e) => e.step === 'checkout' && e.status !== 'start')?.status).toBe('skip');
    expect(fx.read(fx.work, 'shared.txt')).toBe('upstream\n');
    expect(fx.read(fx.work, 'mine.txt')).toBe('wip');
  });

  it('branch not found: creates from the configured base when confirmed, without an upstream', async () => {
    const fx = makeFixture();
    const prompt = scripted(true);
    const r = await switchBranch(fx.work, 'feat-1', { base: 'origin/feature' }, prompt);
    expect(r.outcome).toBe('switched');
    expect(prompt.asked[0]).toMatchObject({ kind: 'createBranch', base: 'origin/feature' });
    expect(branchOf(fx.work)).toBe('feat-1');
    expect(fx.exists(fx.work, 'feature.txt')).toBe(true);
    expect(r.events.find((e) => e.step === 'pull' && e.status === 'skip')).toBeTruthy();
  });

  it('branch not found: defaults the base to the remote HEAD branch', async () => {
    const fx = makeFixture();
    const prompt = scripted(true);
    await switchBranch(fx.work, 'feat-2', {}, prompt);
    expect(prompt.asked[0]).toMatchObject({ kind: 'createBranch', base: 'origin/main', baseIsFallback: false });
  });

  it('branch not found and declined: cancelled with nothing changed', async () => {
    const fx = makeFixture();
    fx.write(fx.work, 'shared.txt', 'wip\n');
    const r = await switchBranch(fx.work, 'nope', {}, scripted(false));
    expect(r.outcome).toBe('cancelled');
    expect(branchOf(fx.work)).toBe('main');
    expect(stashList(fx.work)).toBe('');
    expect(fx.read(fx.work, 'shared.txt')).toBe('wip\n');
  });

  it('stops when a branch name differs only in case', async () => {
    const fx = makeFixture();
    fx.pushNewBranch('Feature-X');
    fx.write(fx.work, 'shared.txt', 'wip\n');
    const r = await switchBranch(fx.work, 'feature-x', {}, scripted());
    expect(r.outcome).toBe('failed');
    expect(r.failedStep).toBe('resolve');
    expect(r.error).toContain('origin/Feature-X');
    expect(stashList(fx.work)).toBe('');
  });

  it('rejects invalid branch names', async () => {
    const fx = makeFixture();
    for (const bad of ['--force', 'a..b', 'bad name']) {
      const r = await switchBranch(fx.work, bad, {}, scripted());
      expect(r.outcome, bad).toBe('failed');
      expect(r.failedStep).toBe('resolve');
    }
  });

  it('removes a clean worktree holding the branch once confirmed', async () => {
    const fx = makeFixture();
    const wt = join(fx.dir, 'wt');
    sh(fx.work, 'worktree', 'add', '-q', wt, 'feature');
    const prompt = scripted(true);
    const r = await switchBranch(fx.work, 'feature', {}, prompt);
    expect(r.outcome).toBe('switched');
    expect(prompt.asked.map((a) => a.kind)).toEqual(['removeWorktree']);
    expect(fx.exists(fx.dir, 'wt')).toBe(false);
    expect(branchOf(fx.work)).toBe('feature');
  });

  it('dirty worktree: needs a second confirmation, and cancel on it leaves everything intact', async () => {
    const fx = makeFixture();
    const wt = join(fx.dir, 'wt');
    sh(fx.work, 'worktree', 'add', '-q', wt, 'feature');
    fx.write(wt, 'feature.txt', 'precious');
    const prompt = scripted(true, false);
    const r = await switchBranch(fx.work, 'feature', {}, prompt);
    expect(r.outcome).toBe('cancelled');
    expect(prompt.asked[0]).toMatchObject({ kind: 'removeWorktree', worktree: { path: wt, uncommitted: 1 } });
    expect(prompt.asked[1]?.kind).toBe('confirmDirtyWorktree');
    expect(fx.read(wt, 'feature.txt')).toBe('precious');
    expect(branchOf(fx.work)).toBe('main');
  });

  it('dirty + locked worktree: force-removes after both confirmations and reports unpushed commits', async () => {
    const fx = makeFixture();
    const wt = join(fx.dir, 'wt');
    sh(fx.work, 'worktree', 'add', '-q', wt, 'feature');
    fx.commit(wt, 'feature.txt', 'local only');
    fx.write(wt, 'scratch.txt', 'x');
    sh(fx.work, 'worktree', 'lock', wt);
    const prompt = scripted(true, true);
    const r = await switchBranch(fx.work, 'feature', {}, prompt);
    expect(r.outcome).toBe('switched');
    expect(prompt.asked[0]).toMatchObject({ worktree: { locked: true, unpushed: 1, untracked: 1 } });
    expect(fx.exists(fx.dir, 'wt')).toBe(false);
    // The unpushed commit survives on the branch itself.
    expect(fx.read(fx.work, 'feature.txt')).toBe('local only');
  });

  it('never removes the main checkout', async () => {
    const fx = makeFixture();
    const wt = join(fx.dir, 'wt');
    sh(fx.work, 'worktree', 'add', '-q', wt, 'feature');
    const r = await switchBranch(wt, 'main', {}, scripted());
    expect(r.outcome).toBe('failed');
    expect(r.failedStep).toBe('worktree');
    expect(r.error).toContain('main checkout');
  });

  it('prunes a stale worktree entry automatically', async () => {
    const fx = makeFixture();
    const wt = join(fx.dir, 'wt');
    sh(fx.work, 'worktree', 'add', '-q', wt, 'feature');
    rmSync(wt, { recursive: true, force: true });
    const r = await switchBranch(fx.work, 'feature', {}, scripted());
    expect(r.outcome).toBe('switched');
  });

  it('diverged pull: stops with the stash retained and recovery instructions', async () => {
    const fx = makeFixture();
    fx.commit(fx.other, 'shared.txt', 'theirs\n');
    sh(fx.other, 'push', '-q');
    fx.commit(fx.work, 'shared.txt', 'ours\n');
    fx.write(fx.work, 'wip.txt', 'wip');
    sh(fx.work, 'switch', '-q', 'feature');
    const r = await switchBranch(fx.work, 'main', {}, scripted());
    expect(r.outcome).toBe('failed');
    expect(r.failedStep).toBe('pull');
    expect(r.stashRef).toBe('stash@{0}');
    expect(r.recovery).toContain('git stash pop stash@{0}');
    expect(branchOf(fx.work)).toBe('main');
  });

  it('pop conflict: stops, lists conflicted files, and git keeps the stash', async () => {
    const fx = makeFixture();
    sh(fx.work, 'switch', '-q', 'feature');
    sh(fx.work, 'switch', '-q', 'main');
    fx.write(fx.work, 'feature.txt', 'my version');
    sh(fx.work, 'add', 'feature.txt');
    const r = await switchBranch(fx.work, 'feature', {}, scripted());
    expect(r.outcome).toBe('failed');
    expect(r.failedStep).toBe('pop');
    expect(r.conflictedFiles).toEqual(['feature.txt']);
    expect(r.stashRef).toBeDefined();
    expect(await findStash(fx.work, `#${r.runId}`)).toBe(r.stashRef);
  });

  it('refuses to start mid-rebase', async () => {
    const fx = makeFixture();
    const gitDir = sh(fx.work, 'rev-parse', '--absolute-git-dir');
    mkdirSync(join(gitDir, 'rebase-merge'));
    writeFileSync(join(gitDir, 'rebase-merge', 'head-name'), 'refs/heads/main');
    const r = await switchBranch(fx.work, 'feature', {}, scripted());
    expect(r.outcome).toBe('failed');
    expect(r.failedStep).toBe('preflight');
    expect(r.error).toContain('rebase');
  });

  it('fails cleanly outside a git repo', async () => {
    const fx = makeFixture();
    const r = await switchBranch(fx.dir, 'main', {}, scripted());
    expect(r.outcome).toBe('failed');
    expect(r.failedStep).toBe('preflight');
  });

  it('a clean empty repo (no commits yet) can "switch" to the branch it is on', async () => {
    const fx = makeFixture();
    const empty = join(fx.dir, 'empty');
    sh(fx.dir, 'init', '-q', '-b', 'main', empty);
    const r = await switchBranch(empty, 'main', {}, scripted());
    expect(r.outcome, r.error).toBe('switched');
  });

  it('works in a repo with no remotes', async () => {
    const fx = makeFixture();
    sh(fx.work, 'remote', 'remove', 'origin');
    sh(fx.work, 'branch', 'local-only');
    const r = await switchBranch(fx.work, 'local-only', {}, scripted());
    expect(r.outcome).toBe('switched');
  });
});

describe('switchMany', () => {
  it('one repo failing does not stop the others', async () => {
    const a = makeFixture();
    const b = makeFixture();
    const c = makeFixture();
    const gitDir = sh(b.work, 'rev-parse', '--absolute-git-dir');
    writeFileSync(join(gitDir, 'MERGE_HEAD'), sh(b.work, 'rev-parse', 'HEAD'));
    const results = await switchMany([{ path: a.work }, { path: b.work }, { path: c.work }], 'feature', scripted());
    expect(results.map((r) => r.outcome)).toEqual(['switched', 'failed', 'switched']);
    expect(new Set(results.map((r) => r.runId)).size).toBe(3);
  });
});

describe('default base without origin/HEAD', () => {
  it('falls back to origin/main before HEAD', async () => {
    const fx = makeFixture();
    sh(fx.work, 'remote', 'set-head', 'origin', '--delete');
    sh(fx.work, 'switch', '-q', 'feature');
    const prompt = scripted(false);
    await switchBranch(fx.work, 'feat-3', {}, prompt);
    expect(prompt.asked[0]).toMatchObject({ base: 'origin/main', baseIsFallback: false });
  });
});

// On a case-insensitive filesystem (macOS default) a loose ref directory `Ticket/` swallows new
// `ticket/...` refs, which then read back as `Ticket/...`.
const caseInsensitiveFs = (() => {
  const d = mkdtempSync(join(tmpdir(), 'git-helper-case-'));
  writeFileSync(join(d, 'a'), '');
  return existsSync(join(d, 'A'));
})();
const heads = (repo: string) => sh(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/').split('\n');

describe.skipIf(!caseInsensitiveFs)('case-folding filesystems', () => {
  function withCapitalFeatureDir() {
    const fx = makeFixture();
    fx.pushNewBranch('Ticket/old');
    fx.pushNewBranch('ticket/new');
    sh(fx.work, 'fetch', '-q');
    sh(fx.work, 'branch', 'Ticket/old', 'origin/Ticket/old'); // creates loose .git/refs/heads/Ticket/
    return fx;
  }

  it('tracking a remote branch keeps the exact case typed', async () => {
    const fx = withCapitalFeatureDir();
    const r = await switchBranch(fx.work, 'ticket/new', {}, scripted());
    expect(r.outcome).toBe('switched');
    expect(heads(fx.work)).toContain('refs/heads/ticket/new');
    expect(heads(fx.work)).not.toContain('refs/heads/Ticket/new');
    expect(heads(fx.work)).toContain('refs/heads/Ticket/old'); // other branches untouched
    expect(sh(fx.work, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/ticket/new');
  });

  it('creating a new branch keeps the exact case typed', async () => {
    const fx = withCapitalFeatureDir();
    const r = await switchBranch(fx.work, 'ticket/brand-new', {}, scripted(true));
    expect(r.outcome).toBe('switched');
    expect(heads(fx.work)).toContain('refs/heads/ticket/brand-new');
  });

  it('a folded remote-tracking directory does not swallow a freshly fetched branch', async () => {
    const fx = makeFixture();
    fx.pushNewBranch('Ticket/old');
    sh(fx.work, 'fetch', '-q');
    sh(fx.work, 'update-ref', 'refs/remotes/origin/Ticket/old', 'origin/Ticket/old'); // loose remote dir
    fx.pushNewBranch('ticket/later');
    const r = await switchBranch(fx.work, 'ticket/later', {}, scripted());
    expect(r.outcome).toBe('switched');
    expect(heads(fx.work)).toContain('refs/heads/ticket/later');
    expect(sh(fx.work, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/ticket/later');
  });

  it('renames a branch stored with the wrong case without asking when the remote has the exact name', async () => {
    const fx = withCapitalFeatureDir();
    // Reproduce the fold the old way: HEAD says ticket/new, the ref is stored as Ticket/new.
    sh(fx.work, 'switch', '-q', '-c', 'ticket/new', '--track', 'origin/ticket/new');
    expect(heads(fx.work)).toContain('refs/heads/Ticket/new');
    fx.write(fx.work, 'wip.txt', 'wip');
    const prompt = scripted();
    const r = await switchBranch(fx.work, 'ticket/new', {}, prompt);
    expect(prompt.asked).toEqual([]);
    expect(r.outcome).toBe('switched');
    // It is the current branch, so preflight repairs it before anything reads HEAD.
    expect(r.events.some((e) => e.step === 'preflight' && e.message.includes('Ticket/new → ticket/new'))).toBe(true);
    expect(heads(fx.work)).toContain('refs/heads/ticket/new');
    expect(heads(fx.work)).not.toContain('refs/heads/Ticket/new');
    expect(sh(fx.work, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/ticket/new');
    expect(fx.read(fx.work, 'wip.txt')).toBe('wip');
  });

  it('asks before renaming a local-only branch stored with the wrong case; declining changes nothing', async () => {
    const fx = withCapitalFeatureDir();
    sh(fx.work, 'branch', 'ticket/local-only'); // folds to Ticket/local-only; not on the remote
    expect(heads(fx.work)).toContain('refs/heads/Ticket/local-only');
    const declined = await switchBranch(fx.work, 'ticket/local-only', {}, scripted(false));
    expect(declined.outcome).toBe('cancelled');
    expect(heads(fx.work)).toContain('refs/heads/Ticket/local-only');
    expect(branchOf(fx.work)).toBe('main');
    const prompt = scripted(true);
    const r = await switchBranch(fx.work, 'ticket/local-only', {}, prompt);
    expect(prompt.asked[0]).toMatchObject({ kind: 'fixBranchCase', stored: 'Ticket/local-only' });
    expect(r.outcome).toBe('switched');
    expect(heads(fx.work)).toContain('refs/heads/ticket/local-only');
  });

  it('repairs a tracking ref that is folded and stale, then pulls the real upstream commit', async () => {
    const fx = makeFixture();
    fx.pushNewBranch('Ticket/old'); // the remote really has both Ticket/ and ticket/ branches
    fx.pushNewBranch('ticket/new');
    sh(fx.work, 'fetch', '-q');
    sh(fx.work, 'switch', '-q', '-c', 'ticket/new', '--track', 'origin/ticket/new');
    sh(fx.work, 'pack-refs', '--all'); // exact names, packed
    // Someone pushes to ticket/new; a plain fetch then writes the update into a Ticket/ directory.
    sh(fx.other, 'fetch', '-q');
    sh(fx.other, 'switch', '-q', '--detach', 'origin/ticket/new');
    fx.commit(fx.other, 'upstream.txt', 'new upstream work');
    sh(fx.other, 'push', '-q', 'origin', 'HEAD:refs/heads/ticket/new');
    sh(fx.remote, 'pack-refs', '--all');
    const upstreamSha = sh(fx.other, 'rev-parse', 'HEAD');
    sh(fx.work, 'update-ref', 'refs/remotes/origin/Ticket/old', 'origin/Ticket/old'); // loose Ticket/ dir
    sh(fx.work, 'fetch', '-q');
    const tracking = sh(fx.work, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes/origin/');
    expect(tracking).toContain(`refs/remotes/origin/Ticket/new ${upstreamSha}`); // folded copy is the fresh one
    // The listed exact name is stale (a plain lookup still finds the folded loose file, which is why
    // git itself looks fine until the next pack-refs makes the stale entry win).
    expect(sh(fx.work, 'for-each-ref', '--format=%(objectname)', 'refs/remotes/origin/ticket/new')).not.toBe(upstreamSha);

    const r = await switchBranch(fx.work, 'ticket/new', {}, scripted());
    expect(r.outcome).toBe('switched');
    expect(sh(fx.work, 'rev-parse', 'HEAD')).toBe(upstreamSha);
    expect(sh(fx.work, 'for-each-ref', '--format=%(objectname)', 'refs/remotes/origin/ticket/new')).toBe(upstreamSha);
    expect(sh(fx.work, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/')).not.toContain('refs/remotes/origin/Ticket/new');
    sh(fx.work, 'pack-refs', '--all'); // and it stays right after the next gc
    expect(sh(fx.work, 'rev-parse', 'refs/remotes/origin/ticket/new')).toBe(upstreamSha);
    expect(fx.read(fx.work, 'upstream.txt')).toBe('new upstream work');
  });
});

describe.skipIf(!caseInsensitiveFs)('checkouts broken by a fold plus a pack', () => {
  /** Reproduces the real failure: folded HEADs in two checkouts, then `git gc` packs refs. */
  function brokenCheckouts() {
    const fx = makeFixture();
    fx.pushNewBranch('ticket/a');
    fx.pushNewBranch('ticket/b');
    sh(fx.work, 'fetch', '-q');
    sh(fx.work, 'branch', 'Ticket/other'); // a capital directory exists
    sh(fx.work, 'switch', '-q', '-c', 'ticket/a', '--track', 'origin/ticket/a'); // folds to Ticket/a
    const wt = join(fx.dir, 'wt-b');
    sh(fx.work, 'worktree', 'add', '-q', '-b', 'ticket/b', wt, 'origin/ticket/b'); // folds to Ticket/b
    sh(fx.work, 'pack-refs', '--all'); // what gc --auto did — both HEADs now point at nothing
    return { fx, wt };
  }

  it('reproduces: both checkouts look like they have no commits', () => {
    const { fx, wt } = brokenCheckouts();
    expect(() => sh(fx.work, 'rev-parse', '--verify', 'HEAD')).toThrow();
    expect(() => sh(wt, 'rev-parse', '--verify', 'HEAD')).toThrow();
  });

  it('a switch from a broken checkout repairs every folded checkout first, then switches', async () => {
    const { fx, wt } = brokenCheckouts();
    fx.write(fx.work, 'wip.txt', 'wip');
    const r = await switchBranch(fx.work, 'main', {}, scripted());
    expect(r.outcome, r.error).toBe('switched');
    expect(r.events.find((e) => e.step === 'preflight' && e.status === 'ok')?.message).toContain('repaired 2 branch');
    expect(branchOf(fx.work)).toBe('main');
    expect(fx.read(fx.work, 'wip.txt')).toBe('wip');
    expect(heads(fx.work)).toEqual(expect.arrayContaining(['refs/heads/ticket/a', 'refs/heads/ticket/b', 'refs/heads/Ticket/other']));
    expect(heads(fx.work)).not.toContain('refs/heads/Ticket/a');
    expect(sh(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('ticket/b'); // the other checkout works again
    sh(fx.work, 'pack-refs', '--all'); // and survives the next gc
    expect(sh(wt, 'rev-parse', '--verify', 'HEAD')).toMatch(/^[0-9a-f]{40}$/);
  });

  it('repairCase fixes them without switching anything', async () => {
    const { repairCase } = await import('../src/index.js');
    const { fx, wt } = brokenCheckouts();
    const repaired = await repairCase(fx.work);
    expect(repaired.map((f) => `${f.stored}→${f.head}`).sort()).toEqual(['Ticket/a→ticket/a', 'Ticket/b→ticket/b']);
    expect(sh(fx.work, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('ticket/a');
    expect(sh(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('ticket/b');
    expect(await repairCase(fx.work)).toEqual([]); // idempotent
  });
});
