import { useEffect, useState } from 'react';
import type { WorktreeDetails } from '@git-helper/core';
import { api, type RepoView } from '../api';

interface Props {
  repo: RepoView;
  selected: boolean;
  busy: boolean;
  onToggle(): void;
  onChanged(): void;
  onError(message: string): void;
}

export function RepoCard({ repo, selected, busy, onToggle, onChanged, onError }: Props) {
  const [worktrees, setWorktrees] = useState<WorktreeDetails[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [base, setBase] = useState(repo.base ?? '');
  const s = repo.state;
  const others = s ? s.worktrees.length - 1 : 0;

  const loadWorktrees = async () => {
    try {
      setWorktrees((await api.worktrees(repo.id)).filter((w) => !w.isMain));
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const toggleWorktrees = () => (worktrees ? setWorktrees(null) : void loadWorktrees());

  // An open worktree list goes stale after every refresh (a switch may have removed one).
  useEffect(() => {
    if (!worktrees) return;
    if (others === 0) setWorktrees(null);
    else void loadWorktrees();
  }, [repo]);

  const saveBase = async () => {
    try {
      await api.updateRepo(repo.id, { base: base.trim() });
      setEditing(false);
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const remove = async () => {
    if (!confirm(`Unregister "${repo.name}"? Files on disk are not touched.`)) return;
    try {
      await api.removeRepo(repo.id);
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <article className={`card ${selected ? 'selected' : ''} ${repo.missing || repo.error ? 'broken' : ''}`}>
      <label className="card-head">
        <input type="checkbox" checked={selected} onChange={onToggle} disabled={busy || repo.missing} />
        <span className="repo-name">{repo.name}</span>
        {busy && <span className="badge info">switching…</span>}
      </label>
      <div className="path" title={repo.path}>{repo.path}</div>

      {repo.missing && <div className="badge danger">path missing</div>}
      {repo.error && <div className="notice error small">{repo.error}</div>}
      {s && (
        <>
          <div className="branch-line">
            <span className="branch">{s.branch ?? '(detached HEAD)'}</span>
            {s.upstream && <span className="muted">→ {s.upstream}</span>}
          </div>
          <div className="badges">
            {s.uncommitted > 0 && <span className="badge warn">{s.uncommitted} changed</span>}
            {s.untracked > 0 && <span className="badge warn">{s.untracked} untracked</span>}
            {s.ahead > 0 && <span className="badge">↑{s.ahead}</span>}
            {s.behind > 0 && <span className="badge">↓{s.behind}</span>}
            {s.inProgress !== 'none' && <span className="badge danger">{s.inProgress} in progress</span>}
            {s.uncommitted + s.untracked === 0 && s.inProgress === 'none' && <span className="badge ok">clean</span>}
          </div>
        </>
      )}

      <div className="card-foot">
        {editing ? (
          <span className="inline-edit">
            <input value={base} onChange={(e) => setBase(e.target.value)} placeholder="remote default" aria-label="Base for new branches" />
            <button onClick={saveBase}>Save</button>
            <button className="ghost" onClick={() => setEditing(false)}>Cancel</button>
          </span>
        ) : (
          <button className="link" onClick={() => setEditing(true)} title="Start point used when a branch has to be created">
            base: {repo.base ?? 'remote default'}
          </button>
        )}
        <span className="spacer" />
        {others > 0 && (
          <button className="link" onClick={toggleWorktrees}>
            {others} worktree{others === 1 ? '' : 's'} {worktrees ? '▴' : '▾'}
          </button>
        )}
        <button className="link danger" onClick={remove} disabled={busy}>remove</button>
      </div>

      {worktrees && (
        <ul className="worktrees">
          {worktrees.map((w) => (
            <li key={w.path}>
              <span className="branch small">{w.branch ?? '(detached)'}</span>
              <span className="path" title={w.path}>{w.path}</span>
              {w.uncommitted + w.untracked > 0 && <span className="badge warn">{w.uncommitted + w.untracked} dirty</span>}
              {w.unpushed > 0 && <span className="badge">{w.unpushed} unpushed</span>}
              {w.locked && <span className="badge">locked</span>}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
