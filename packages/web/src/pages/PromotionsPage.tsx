import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { PromotionStep } from '@git-helper/core';
import { api, type Promotion, type PromotionsView, type RepoView } from '../api';

const REFRESH_MS = 5000;
const ICON: Record<PromotionStep['status'], string> = { merged: '✓', skipped: '–', open: '●', pending: '·', closed: '✗', failed: '✗' };
const BADGE: Record<Promotion['status'], string> = { running: 'info', done: 'ok', stopped: 'warn', aborted: 'danger', failed: 'danger' };

function StepChain({ steps }: { steps: PromotionStep[] }) {
  return (
    <ol className="chain">
      {steps.map((s) => (
        <li key={`${s.from}-${s.to}`} className={`chain-step ${s.status}`}>
          <span className="mark" aria-hidden>{ICON[s.status]}</span>
          <span className="chain-branches">
            <code>{s.from}</code> → <code>{s.to}</code>
          </span>
          <span className={`badge ${s.status === 'merged' ? 'ok' : s.status === 'open' ? 'warn' : s.status === 'failed' || s.status === 'closed' ? 'danger' : ''}`}>{s.status}</span>
          {s.autoMerge && <span className="badge info">auto-merge</span>}
          {s.pr && (
            <a href={s.pr.url} target="_blank" rel="noreferrer" className={s.status === 'open' ? 'pr-link primary-link' : 'pr-link'}>
              PR #{s.pr.number}{s.status === 'open' ? ' — open to merge ↗' : ' ↗'}
            </a>
          )}
          {s.message && s.status !== 'pending' && <span className="muted small chain-msg">{s.message}</span>}
        </li>
      ))}
    </ol>
  );
}

export function PromotionsPage() {
  const [data, setData] = useState<PromotionsView | null>(null);
  const [repos, setRepos] = useState<RepoView[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [from, setFrom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [p, r] = await Promise.all([api.promotions(), api.repos()]);
      setData(p);
      setRepos(r);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const withPipeline = repos.filter((r) => r.pipeline);
  const running = new Set((data?.promotions ?? []).filter((p) => p.status === 'running').map((p) => p.repoId));
  const stagesOfSelected = [...new Set(withPipeline.filter((r) => selected.has(r.id)).flatMap((r) => r.pipeline!.stages.slice(0, -1)))];

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const start = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      const r = await api.startPromotions([...selected], from || undefined);
      if (r.errors.length) setError(r.errors.map((x) => `${x.repo}: ${x.error}`).join('; '));
      setSelected(new Set());
    });
  };

  return (
    <div className="page">
      <section className="switchbar">
        <form className="switch-form" onSubmit={start}>
          <div className="repo-picks">
            {withPipeline.length === 0 && <span className="muted">No repo has a pipeline yet — set one on its card in Repos.</span>}
            {withPipeline.map((r) => (
              <label key={r.id} className={`pick ${running.has(r.id) ? 'disabled' : ''}`} title={running.has(r.id) ? 'already promoting' : r.pipeline!.stages.join(' → ')}>
                <input
                  type="checkbox"
                  disabled={running.has(r.id)}
                  checked={selected.has(r.id)}
                  onChange={() =>
                    setSelected((s) => {
                      const n = new Set(s);
                      if (n.has(r.id)) n.delete(r.id);
                      else n.add(r.id);
                      return n;
                    })
                  }
                />
                <strong>{r.name}</strong> <span className="muted small">{r.pipeline!.stages.join(' → ')}</span>
              </label>
            ))}
          </div>
          <select value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Start from stage">
            <option value="">from first stage</option>
            {stagesOfSelected.map((s) => (
              <option key={s} value={s}>from {s}</option>
            ))}
          </select>
          <button type="submit" className="primary" disabled={selected.size === 0 || busy}>
            Promote {selected.size || ''}
          </button>
        </form>
        <div className="small muted worker-line">
          {data?.worker.polling
            ? `Worker running here — checks GitHub every ${Math.round(data.worker.intervalMs / 1000)}s.`
            : data?.worker.holder
              ? `Worker running in another git-helper process (pid ${data.worker.holder}).`
              : 'No worker is polling; promotions advance when one runs.'}{' '}
          <button className="link small" onClick={() => void act(() => api.checkPromotions())} disabled={busy}>Check now</button>
        </div>
      </section>

      {error && (
        <div className="notice error" role="alert">
          {error} <button className="link" onClick={() => setError(null)}>dismiss</button>
        </div>
      )}

      <div className="section-head">
        <h2>Promotions</h2>
      </div>
      {!data ? (
        <div className="muted">Loading…</div>
      ) : data.promotions.length === 0 ? (
        <div className="empty">
          <p>No promotions yet.</p>
          <p className="muted">Pick repos above, or run <code>git-helper promote &lt;repo&gt;</code>.</p>
        </div>
      ) : (
        <div className="promotions">
          {data.promotions.map((p) => (
            <article key={p.id} className={`card promotion ${p.status}`}>
              <header className="row">
                <span className="repo-name">{p.repoName}</span>
                <span className={`badge ${BADGE[p.status]}`}>{p.status}</span>
                <span className="muted small">{p.id} · {new Date(p.createdAt).toLocaleString()}</span>
                <span className="spacer" />
                {p.status === 'running' && <button className="small" onClick={() => void act(() => api.stopPromotion(p.id))} disabled={busy}>Stop</button>}
                {(p.status === 'stopped' || p.status === 'failed' || p.status === 'aborted') && (
                  <button className="small primary" onClick={() => void act(() => api.resumePromotion(p.id))} disabled={busy}>Resume</button>
                )}
              </header>
              <StepChain steps={p.steps} />
              {p.error && p.status !== 'running' && <div className="recovery">{p.error}</div>}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
