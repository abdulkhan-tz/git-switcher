import { useState } from 'react';
import type { PromptRequest } from '@git-helper/core';

export function PromptDialog({ repoName, request, onAnswer }: { repoName: string; request: PromptRequest; onAnswer(answer: boolean): void }) {
  const [typed, setTyped] = useState('');

  let title: string;
  let body: React.ReactNode;
  let confirmLabel: string;
  let danger = false;
  let canConfirm = true;

  switch (request.kind) {
    case 'createBranch':
      title = `Create “${request.branch}”?`;
      body = (
        <p>
          The branch does not exist locally or on the remote. Create it from <code>{request.base}</code>?
          {request.baseIsFallback && <span className="muted"> (no remote default branch found — this is the current HEAD)</span>}
        </p>
      );
      confirmLabel = 'Create branch';
      break;
    case 'removeWorktree': {
      const w = request.worktree;
      title = `“${request.branch}” is checked out in another worktree`;
      body = (
        <dl className="facts">
          <dt>Path</dt><dd><code>{w.path}</code></dd>
          <dt>Uncommitted</dt><dd className={w.uncommitted + w.untracked ? 'warn' : ''}>{w.uncommitted} changed, {w.untracked} untracked</dd>
          <dt>Unpushed</dt><dd>{w.unpushed} commit(s) — they stay on the branch</dd>
          <dt>Locked</dt><dd>{w.locked ? 'yes' : 'no'}</dd>
        </dl>
      );
      confirmLabel = 'Delete worktree & continue';
      danger = true;
      break;
    }
    case 'fixBranchCase':
      title = `Fix the case of “${request.branch}”?`;
      body = (
        <p>
          The local branch is stored as <code>{request.stored}</code>. macOS ignores case in file names, so git folded it into an
          existing directory. Rename it to exactly <code>{request.branch}</code>? Commits and upstream are kept.
        </p>
      );
      confirmLabel = 'Rename branch';
      break;
    case 'confirmDirtyWorktree':
      title = 'Uncommitted changes will be destroyed';
      body = (
        <>
          <p>
            <code>{request.worktree.path}</code> has {request.worktree.uncommitted + request.worktree.untracked} uncommitted or untracked file(s).
            Deleting the worktree removes them permanently.
          </p>
          <label>
            <span>
              Type <strong>yes</strong> to confirm
            </span>
            <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Type yes to confirm" />
          </label>
        </>
      );
      confirmLabel = 'Delete anyway';
      danger = true;
      canConfirm = typed === 'yes';
      break;
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="prompt-title">
        <div className="muted small">{repoName}</div>
        <h2 id="prompt-title">{title}</h2>
        {body}
        <div className="modal-actions">
          <button className="ghost" onClick={() => onAnswer(false)}>Cancel</button>
          <button className={danger ? 'danger' : 'primary'} disabled={!canConfirm} onClick={() => onAnswer(true)}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
