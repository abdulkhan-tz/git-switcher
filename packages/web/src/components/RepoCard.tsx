import { useEffect, useState, type MouseEvent } from 'react';
import type { WorktreeDetails } from '@tidy/core';
import { api, type RepoView } from '../api';
import { PipelineEditor } from './PipelineEditor';

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
  const [editingPipeline, setEditingPipeline] = useState(false);
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

  const selectable = !busy && !repo.missing;
  // A click anywhere on the card selects it. Controls keep their own behaviour, and the header label
  // already toggles its checkbox, so neither is handled here (that would toggle twice).
  const onCardClick = (e: MouseEvent<HTMLElement>) => {
    if (!selectable) return;
    if ((e.target as HTMLElement).closest('button, a, input, select, textarea, label, summary, details, [role="button"]')) return;
    if (window.getSelection()?.toString()) return; // the user was selecting text to copy
    onToggle();
  };

  return (
    <article className={`repo-row ${selected ? 'selected' : ''} ${repo.missing || repo.error ? 'broken' : ''} ${selectable ? 'selectable' : ''}`} onClick={onCardClick}>
      <div className="row-main">
        <label className="row-name">
          <input type="checkbox" checked={selected} onChange={onToggle} disabled={!selectable} />
          <span className="row-title">
            <span className="repo-name">{repo.name} {busy && <span className="badge info">switching…</span>}</span>
            <span className="path" title={repo.path}>{repo.path}</span>
          </span>
        </label>
        <div className="row-branch">
          {repo.missing ? (
            <span className="badge danger">path missing</span>
          ) : s ? (
            <>
              <span className="branch" title={s.branch ?? ''}>{s.branch ?? '(detached HEAD)'}</span>
              {s.upstream && <span className="muted small">→ {s.upstream}</span>}
            </>
          ) : null}
        </div>
        <div className="badges row-status">
          {s && (
            <>
              {s.uncommitted > 0 && <span className="badge warn">{s.uncommitted} changed</span>}
              {s.untracked > 0 && <span className="badge warn">{s.untracked} untracked</span>}
              {s.ahead > 0 && <span className="badge">↑{s.ahead}</span>}
              {s.behind > 0 && <span className="badge">↓{s.behind}</span>}
              {s.inProgress !== 'none' && <span className="badge danger">{s.inProgress} in progress</span>}
              {s.uncommitted + s.untracked === 0 && s.inProgress === 'none' && <span className="badge ok">clean</span>}
            </>
          )}
        </div>
        <div className="row-meta">
          <button className="link pipeline-line" onClick={() => setEditingPipeline(true)} title="Upstream promotion order">
            {repo.pipeline ? `⇡ ${repo.pipeline.stages.join(' → ')}` : '⇡ set up promotion pipeline'}
          </button>
          <button className="link" onClick={() => setEditing(true)} title="Start point used when a branch has to be created">
            base: {repo.base ?? 'remote default'}
          </button>
        </div>
        <div className="repo-actions">
          {others > 0 && (
            <button className="link" onClick={toggleWorktrees}>
              {others} worktree{others === 1 ? '' : 's'} {worktrees ? '▴' : '▾'}
            </button>
          )}
          <button className="link danger" onClick={remove} disabled={busy}>remove</button>
        </div>
      </div>

      {repo.folded && repo.folded.length > 0 && (
        <div className="notice error small" role="alert">
          {repo.folded.length} checkout(s) on a branch macOS stored with the wrong case
          {repo.folded.some((f) => f.path === repo.path) ? ' (including this one — git may say it has no commits)' : ''}:
          <ul className="folded">
            {repo.folded.map((f) => (
              <li key={f.path}>
                <code>{f.stored}</code> → <code>{f.head}</code>
              </li>
            ))}
          </ul>
          <button
            className="small"
            disabled={busy}
            onClick={async () => {
              try {
                await api.repairCase(repo.id);
                onChanged();
              } catch (e) {
                onError((e as Error).message);
              }
            }}
          >
            Repair
          </button>
        </div>
      )}
      {repo.error && <div className="notice error small">{repo.error}</div>}

      {editingPipeline && (
        <PipelineEditor
          repo={repo}
          onSaved={() => {
            setEditingPipeline(false);
            onChanged();
          }}
          onCancel={() => setEditingPipeline(false)}
          onError={onError}
        />
      )}
      {editing && (
        <span className="inline-edit">
          <input value={base} onChange={(e) => setBase(e.target.value)} placeholder="remote default" aria-label="Base for new branches" />
          <button onClick={saveBase}>Save</button>
          <button className="ghost" onClick={() => setEditing(false)}>Cancel</button>
        </span>
      )}

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
