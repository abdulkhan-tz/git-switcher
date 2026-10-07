import { useCallback, useEffect, useState } from 'react';
import { api, type ServiceView } from '../api';

const REFRESH_MS = 3000;

function badge(s: ServiceView): { cls: string; text: string } {
  if (s.job === 'starting' || s.state === 'starting') return { cls: 'warn', text: 'starting…' };
  if (s.job === 'stopping') return { cls: 'warn', text: 'stopping…' };
  if (s.state === 'up') return { cls: 'ok', text: 'up' };
  if (s.state === 'external') return { cls: 'info', text: 'up — started elsewhere' };
  return { cls: '', text: 'down' };
}

export function ServicesPage() {
  const [rows, setRows] = useState<ServiceView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<{ name: string; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRows(await api.services());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
    await refresh();
  };

  const showLog = async (name: string) => {
    if (log?.name === name) return setLog(null);
    try {
      setLog({ name, text: (await api.serviceLog(name)).log || '(no log yet)' });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!rows) return error ? <div className="notice error">{error}</div> : <div className="muted">Loading…</div>;
  if (rows.length === 0) {
    return (
      <div className="empty">
        No services yet. Add them with <code>git-helper services add</code> or <code>git-helper services import &lt;file&gt;</code>.
      </div>
    );
  }

  const busy = rows.some((r) => r.job);
  const anyDown = rows.some((r) => r.state === 'down');
  const anyManaged = rows.some((r) => r.state === 'up' || r.state === 'starting');

  return (
    <div className="page">
      {error && <div className="notice error">{error}</div>}
      <div className="section-head">
        <h2>Services</h2>
        <span className="spacer" />
        <button className="small" disabled={busy || !anyDown} onClick={() => act(() => api.servicesUp([]))}>Start all down</button>
        <button className="ghost small" disabled={busy || !anyManaged} onClick={() => act(() => api.servicesDown([]))}>Stop all</button>
      </div>
      <table className="history">
        <thead>
          <tr>
            <th>Service</th>
            <th>State</th>
            <th>Port</th>
            <th>Needs</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const b = badge(r);
            const canStart = r.state === 'down' && !r.job;
            const canStop = (r.state === 'up' || r.state === 'starting') && !r.job;
            return (
              <tr key={r.name}>
                <td>
                  <strong>{r.name}</strong>
                  {r.description && <div className="muted small">{r.description}</div>}
                  {r.error && <div className="small" style={{ color: 'var(--danger)' }}>{r.error}</div>}
                </td>
                <td>
                  <span className={`badge ${b.cls}`}>{b.text}</span>
                  {r.state === 'external' && r.externalPid && <div className="muted small">pid {r.externalPid} — stop it where you started it</div>}
                </td>
                <td className="path">:{r.port}</td>
                <td className="muted small">{r.dependsOn.join(', ') || '—'}</td>
                <td className="row-actions">
                  {canStart && <button className="small" onClick={() => act(() => api.servicesUp([r.name]))}>Start</button>}
                  {canStop && <button className="ghost small" onClick={() => act(() => api.servicesDown([r.name]))}>Stop</button>}
                  <button className="link small" onClick={() => void showLog(r.name)}>{log?.name === r.name ? 'Hide log' : 'Log'}</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {log && <pre className="notice" style={{ overflow: 'auto', maxHeight: 320, fontSize: 12, whiteSpace: 'pre-wrap' }}>{log.text}</pre>}
      <p className="muted small">Starting a service also starts what it needs. Services started outside git helper are shown but never stopped from here.</p>
    </div>
  );
}
