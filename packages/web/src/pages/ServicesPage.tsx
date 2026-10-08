import { Fragment, useCallback, useEffect, useState } from 'react';
import type { ServiceGroup } from '@tidy/core';
import { api, type ServiceView } from '../api';

const REFRESH_MS = 3000;

function badge(s: ServiceView): { cls: string; text: string } {
  if (s.job === 'starting' || s.state === 'starting') return { cls: 'warn', text: 'starting…' };
  if (s.job === 'stopping') return { cls: 'warn', text: 'stopping…' };
  if (s.state === 'up') return { cls: 'ok', text: 'up' };
  if (s.state === 'external') return { cls: 'info', text: 'up — started elsewhere' };
  return { cls: '', text: 'down' };
}

function Config({ s, onChanged, onError }: { s: ServiceView; onChanged: () => Promise<void>; onError: (m: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ cwd: s.cwd, command: s.command, prepare: s.prepare ?? '', port: String(s.port), dependsOn: s.dependsOn.join(', '), startTimeoutSec: s.startTimeoutSec ? String(s.startTimeoutSec) : '', description: s.description ?? '' });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const save = async () => {
    try {
      await api.updateService(s.name, {
        cwd: form.cwd,
        command: form.command,
        prepare: form.prepare,
        port: Number(form.port),
        dependsOn: form.dependsOn.split(',').map((x) => x.trim()).filter(Boolean),
        startTimeoutSec: form.startTimeoutSec === '' ? null : Number(form.startTimeoutSec),
        description: form.description,
      });
      setEditing(false);
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const rename = async () => {
    const to = prompt(`New name for ${s.name}`, s.name)?.trim();
    if (!to || to === s.name) return;
    try {
      await api.renameService(s.name, to);
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const running = s.state !== 'down';
  const rows: [string, string | undefined][] = [
    ['About', s.description],
    ['Folder', s.cwd],
    ['Port', String(s.port)],
    ['Needs', s.dependsOn.join(', ') || undefined],
    ['Prepare', s.prepare],
    ['Command', s.command],
    ['Environment', s.env && Object.keys(s.env).length ? Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join('\n') : undefined],
    ['Start timeout', s.startTimeoutSec ? `${s.startTimeoutSec}s` : undefined],
    ['Log', s.logFile],
    ['Running as', s.externalCommand],
  ];

  return (
    <div className="notice" style={{ margin: '4px 0 8px' }}>
      {editing ? (
        <div style={{ display: 'grid', gap: 6 }}>
          {([['cwd', 'Folder'], ['command', 'Command (end with exec …)'], ['prepare', 'Prepare (build step, optional)'], ['port', 'Port'], ['dependsOn', 'Needs (comma separated)'], ['startTimeoutSec', 'Start timeout, seconds'], ['description', 'About']] as const).map(([k, label]) => (
            <label key={k} className="small">
              {label}
              <input style={{ width: '100%', fontFamily: 'monospace' }} value={form[k]} onChange={set(k)} />
            </label>
          ))}
          {running && <div className="muted small">Changes apply the next time it starts.</div>}
          <div>
            <button className="small" onClick={() => void save()}>Save</button> <button className="ghost small" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px 12px', margin: 0 }}>
            {rows.filter(([, v]) => v).map(([k, v]) => (
              <Fragment key={k}>
                <dt className="muted small">{k}</dt>
                <dd style={{ margin: 0, fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{v}</dd>
              </Fragment>
            ))}
          </dl>
          <div style={{ marginTop: 8 }}>
            <button className="ghost small" onClick={() => setEditing(true)}>Edit</button> <button className="ghost small" onClick={() => void rename()}>Rename</button>
          </div>
        </>
      )}
    </div>
  );
}

function Groups({ rows, groups, act }: { rows: ServiceView[]; groups: ServiceGroup[]; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const state = (n: string) => rows.find((r) => r.name === n)?.state ?? 'down';
  const busy = rows.some((r) => r.job);
  const save = (name: string, members: string[]) => act(() => api.setServiceGroup(name, members));

  const create = async () => {
    const name = prompt('Group name')?.trim();
    if (!name) return;
    const first = rows[0]?.name;
    if (first) await save(name, [first]);
  };

  return (
    <div style={{ marginTop: 24 }}>
      <div className="section-head">
        <h3>Groups</h3>
        <span className="spacer" />
        <button className="ghost small" onClick={() => void create()}>New group</button>
      </div>
      {groups.length === 0 && <p className="muted small">A group starts several services in a fixed order. Create one, then add services and set the order.</p>}
      {groups.map((g) => {
        const missing = g.members.filter((m) => state(m) === 'down');
        const addable = rows.filter((r) => !g.members.includes(r.name));
        const move = (i: number, d: number) => {
          const m = [...g.members];
          [m[i], m[i + d]] = [m[i + d]!, m[i]!];
          void save(g.name, m);
        };
        return (
          <div key={g.name} className="notice" style={{ margin: '8px 0' }}>
            <div className="section-head" style={{ marginBottom: 6 }}>
              <strong>{g.name}</strong>
              <span className="muted small">{missing.length === 0 ? 'all up' : `${missing.length} down`}</span>
              <span className="spacer" />
              <button className="small" disabled={busy || missing.length === 0} onClick={() => act(() => api.servicesUp([g.name]))}>Start group</button>
              <button className="ghost small" disabled={busy || g.members.every((m) => state(m) === 'down')} onClick={() => act(() => api.servicesDown([g.name]))}>Stop group</button>
              <button
                className="link danger small"
                onClick={() => {
                  if (confirm(`Delete the group ${g.name}? Its services are not touched.`)) void act(() => api.removeServiceGroup(g.name));
                }}
              >
                Delete
              </button>
            </div>
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              {g.members.map((m, i) => (
                <li key={m}>
                  <code>{m}</code> <span className={`badge ${state(m) === 'down' ? '' : 'ok'}`}>{state(m) === 'down' ? 'down' : 'up'}</span>{' '}
                  <button className="link small" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${m} earlier`}>↑</button>{' '}
                  <button className="link small" disabled={i === g.members.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${m} later`}>↓</button>{' '}
                  <button className="link danger small" disabled={g.members.length === 1} onClick={() => void save(g.name, g.members.filter((x) => x !== m))} aria-label={`Remove ${m}`}>✕</button>
                </li>
              ))}
            </ol>
            {addable.length > 0 && (
              <select
                value=""
                onChange={(e) => e.target.value && void save(g.name, [...g.members, e.target.value])}
                aria-label={`Add a service to ${g.name}`}
                style={{ marginTop: 6 }}
              >
                <option value="">+ add service…</option>
                {addable.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
              </select>
            )}
            <div className="muted small">Started top to bottom; each service's own dependencies are started before it if they are not already up. Stopped in reverse.</div>
          </div>
        );
      })}
    </div>
  );
}

export function ServicesPage() {
  const [rows, setRows] = useState<ServiceView[] | null>(null);
  const [groups, setGroups] = useState<ServiceGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<{ name: string; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [r, g] = await Promise.all([api.services(), api.serviceGroups()]);
      setRows(r);
      setGroups(g);
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
        No services yet. Add them with <code>git-tidy services add</code> or <code>git-tidy services import &lt;file&gt;</code>.
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
            const canStopExternal = r.state === 'external' && !r.job && !!r.externalPid;
            return (
              <Fragment key={r.name}>
                <tr className="clickable" onClick={() => setOpen(open === r.name ? null : r.name)}>
                  <td>
                    <strong>{r.name}</strong>
                    {r.description && <div className="muted small">{r.description}</div>}
                    {r.error && <div className="small" style={{ color: 'var(--danger)' }}>{r.error}</div>}
                  </td>
                  <td>
                    <span className={`badge ${b.cls}`}>{b.text}</span>
                    {r.state === 'external' && r.externalPid && (
                      <div className="muted small" title={r.externalCommand}>
                        pid {r.externalPid} · {(r.externalCommand?.split(' ')[0] ?? '').split('/').pop()} — started outside tidy
                      </div>
                    )}
                  </td>
                  <td className="path">:{r.port}</td>
                  <td className="muted small">{r.dependsOn.join(', ') || '—'}</td>
                  <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                    {canStart && <button className="small" onClick={() => act(() => api.servicesUp([r.name]))}>Start</button>}
                    {canStop && <button className="ghost small" onClick={() => act(() => api.servicesDown([r.name]))}>Stop</button>}
                    {canStopExternal && (
                      <button
                        className="ghost small"
                        onClick={() => {
                          if (confirm(`Stop ${r.name}? This ends pid ${r.externalPid}, which was started outside tidy:\n\n${r.externalCommand ?? ''}\n\nStart will then run it under tidy.`)) void act(() => api.servicesDown([r.name], true));
                        }}
                      >
                        Stop
                      </button>
                    )}
                    <button className="link small" onClick={() => void showLog(r.name)}>{log?.name === r.name ? 'Hide log' : 'Log'}</button>
                  </td>
                </tr>
                {open === r.name && (
                  <tr>
                    <td colSpan={5}>
                      <Config key={`${r.name}:${r.cwd}:${r.command}`} s={r} onChanged={refresh} onError={setError} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {log && <pre className="notice" style={{ overflow: 'auto', maxHeight: 320, fontSize: 12, whiteSpace: 'pre-wrap' }}>{log.text}</pre>}
      <p className="muted small">Click a service to see and edit its configuration. Starting a service starts only the services it needs that are not already up. Stop on a service started elsewhere ends only the process listening on its port; Start then runs it under tidy.</p>
      <Groups rows={rows} groups={groups} act={act} />
    </div>
  );
}
