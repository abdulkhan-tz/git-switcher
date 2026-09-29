import { Fragment, useEffect, useState } from 'react';
import type { HistoryEntry } from '@git-helper/core';
import { api } from '../api';

export function HistoryPage() {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    api.history().then(setEntries, (e: Error) => setError(e.message));
  }, []);

  if (error) return <div className="notice error">{error}</div>;
  if (!entries) return <div className="muted">Loading…</div>;
  if (entries.length === 0) return <div className="empty">No runs yet.</div>;

  return (
    <div className="page">
      <h2>History</h2>
      <table className="history">
        <thead>
          <tr>
            <th>When</th>
            <th>Repo</th>
            <th>Switch</th>
            <th>Outcome</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <Fragment key={e.runId}>
              <tr onClick={() => setOpen(open === e.runId ? null : e.runId)} className="clickable">
                <td className="muted">
                  <div className="nowrap">{new Date(e.startedAt).toLocaleString()}</div>
                  <div className="mobile-only">{e.repo.split('/').pop()}</div>
                </td>
                <td className="path" title={e.repo}>{e.repo.split('/').pop()}</td>
                <td><code>{e.from ?? '(detached)'}</code> → <code>{e.to}</code></td>
                <td>
                  <span className={`badge ${e.outcome === 'switched' ? 'ok' : e.outcome === 'failed' ? 'danger' : 'warn'}`}>
                    {e.outcome === 'failed' ? `failed at ${e.failedStep}` : e.outcome}
                  </span>
                  {e.stashRef && <span className="badge warn">stash left: {e.stashRef}</span>}
                </td>
              </tr>
              {open === e.runId && (
                <tr className="detail">
                  <td colSpan={4}>
                    <div className="muted small">{e.repo}</div>
                    <ol className="steps">
                      {e.steps.map((s, i) => (
                        <li key={i} className={s.status}>
                          <span className="mark">{s.status === 'ok' ? '✓' : s.status === 'skip' ? '–' : '✗'}</span>
                          <span className="step-name">{s.step}</span>
                          <span className="step-msg">{s.message}</span>
                        </li>
                      ))}
                    </ol>
                    {e.recovery && <pre className="recovery">{e.recovery}</pre>}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
