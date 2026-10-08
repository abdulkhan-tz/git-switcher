import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api, type ServiceGitView, type ServiceView } from '../api';
import { badge, useServices } from '../components/useServices';

type Tab = 'logs' | 'git' | 'config';

const STATUS: Record<string, string> = { '??': 'untracked', ' M': 'modified', 'M ': 'staged', MM: 'staged + modified', ' D': 'deleted', 'D ': 'deleted (staged)', 'A ': 'added', AM: 'added + modified', UU: 'conflict' };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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

  const rows: [string, string | undefined][] = [
    ['About', s.description],
    ['Groups', s.groups.join(', ') || undefined],
    ['Folder', s.cwd],
    ['Port', String(s.port)],
    ['Needs', s.dependsOn.join(', ') || undefined],
    ['Prepare', s.prepare],
    ['Command', s.command],
    ['Environment', s.env && Object.keys(s.env).length ? Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join('\n') : undefined],
    ['Start timeout', s.startTimeoutSec ? `${s.startTimeoutSec}s` : undefined],
    ['Log file', s.logFile],
    ['Running as', s.externalCommand],
  ];

  return editing ? (
    <div style={{ display: 'grid', gap: 6 }}>
      {([['cwd', 'Folder'], ['command', 'Command (end with exec …)'], ['prepare', 'Prepare (build step, optional)'], ['port', 'Port'], ['dependsOn', 'Needs (comma separated)'], ['startTimeoutSec', 'Start timeout, seconds'], ['description', 'About']] as const).map(([k, label]) => (
        <label key={k} className="small">
          {label}
          <input style={{ width: '100%', fontFamily: 'monospace' }} value={form[k]} onChange={set(k)} />
        </label>
      ))}
      {s.state !== 'down' && <div className="muted small">Changes apply the next time it starts.</div>}
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
      <div style={{ marginTop: 10 }}>
        <button className="ghost small" onClick={() => setEditing(true)}>Edit</button> <button className="ghost small" onClick={() => void rename()}>Rename</button>
      </div>
    </>
  );
}

function BranchSwitcher({ s, act }: { s: ServiceView; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [branches, setBranches] = useState<string[]>([]);
  const [choice, setChoice] = useState('');
  useEffect(() => {
    let alive = true;
    void api.serviceBranches(s.name).then((r) => alive && setBranches(r.branches), () => {});
    return () => {
      alive = false;
    };
  }, [s.name, s.git?.branch]);
  if (!s.git) return null;
  const same = !choice || choice === s.git.branch;
  const known = branches.includes(choice);
  const running = s.state !== 'down';
  const go = () => {
    const stash = s.git!.dirty ? `\n\nYour ${plural(s.git!.dirty, 'uncommitted file')} will be stashed and put back on the new branch.` : '';
    if (!confirm(`Switch ${s.name} from ${s.git!.branch ?? '(detached)'} to ${choice}?${running ? `\n\n${s.name} (and anything that needs it) will be stopped, then started again on the new code.` : ''}${stash}`)) return;
    void act(() => api.switchServiceBranch(s.name, choice, true)).then(() => setChoice(''));
  };
  return (
    <div className="section-head" style={{ margin: '4px 0 10px' }}>
      <span className="muted small">Branch</span>
      <code title={s.git.branch ?? ''}>{s.git.branch ?? '(detached)'}</code>
      <span className="muted small">→</span>
      <input list={`branches-${s.name}`} value={choice} onChange={(e) => setChoice(e.target.value)} placeholder="pick or type a branch…" style={{ minWidth: 260, fontFamily: 'monospace' }} aria-label="Branch to switch to" />
      <datalist id={`branches-${s.name}`}>{branches.map((b) => <option key={b} value={b} />)}</datalist>
      <button className="small" disabled={same || !known || !!s.job} onClick={go} title={choice && !known ? 'No such branch here — it is not created from this screen' : undefined}>
        Switch{running ? ' & restart' : ''}
      </button>
    </div>
  );
}

const MAX_LOG_CHARS = 400_000;

/** Tails a service's log: fetches only the bytes appended since the last poll. */
function LogView({ name }: { name: string }) {
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [live, setLive] = useState(true);
  const [follow, setFollow] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [updated, setUpdated] = useState<Date | null>(null);
  const offset = useRef<number | undefined>(undefined);
  const box = useRef<HTMLPreElement>(null);
  const busy = useRef(false);

  const poll = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const r = await api.serviceLog(name, offset.current);
      offset.current = r.offset;
      setErr(null);
      setUpdated(new Date());
      setLoaded(true);
      if (r.reset) setText(r.text || '');
      else if (r.text) setText((t) => (t + r.text).slice(-MAX_LOG_CHARS));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      busy.current = false;
    }
  }, [name]);

  useEffect(() => {
    offset.current = undefined;
    setText('');
    setLoaded(false);
    void poll();
  }, [name, poll]);

  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => void poll(), 1000);
    return () => clearInterval(t);
  }, [live, poll]);

  // keep the newest line in view while following
  useEffect(() => {
    const el = box.current;
    if (follow && el) el.scrollTop = el.scrollHeight;
  }, [text, follow]);

  const clear = async () => {
    if (!confirm(`Clear the log of ${name}? The file is emptied; the service keeps running and keeps writing to it.`)) return;
    try {
      await api.clearServiceLog(name);
      offset.current = 0;
      setText('');
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div>
      <div className="section-head" style={{ marginBottom: 6 }}>
        <span className={`badge ${live ? 'ok' : ''}`}>{live ? '● live' : 'paused'}</span>
        <button className="ghost small" onClick={() => setLive(!live)}>{live ? 'Pause' : 'Resume'}</button>
        <button className="ghost small" onClick={() => void poll()}>Refresh</button>
        <label className="small" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
        </label>
        <span className="spacer" />
        {updated && <span className="muted small">updated {updated.toLocaleTimeString()}</span>}
        <button className="ghost small" onClick={() => void clear()}>Clear log</button>
      </div>
      {err && <div className="notice error">{err}</div>}
      <pre
        ref={box}
        className="logbox"
        onScroll={(e) => {
          // scrolling up stops following; reaching the bottom again resumes it
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          if (!atBottom && follow) setFollow(false);
          else if (atBottom && !follow) setFollow(true);
        }}
      >
        {text || (loaded ? '(no log yet)' : 'Loading…')}
      </pre>
    </div>
  );
}

function GitView({ name }: { name: string }) {
  const [g, setG] = useState<ServiceGitView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => api.serviceGit(name).then((r) => alive && (setG(r), setErr(null)), (e: Error) => alive && setErr(e.message));
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [name, tick]);

  if (err) return <div className="notice error">{err}</div>;
  if (!g) return <div className="muted">Loading…</div>;
  if (g.root === null) return <div className="empty">This service's folder is not inside a git repository.</div>;
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="section-head">
        <span className="muted small">
          <code>{g.branch ?? '(detached)'}</code> @ <code>{g.head}</code> · <span title={g.root}>{g.root}</span>
        </span>
        <span className="spacer" />
        <button className="ghost small" onClick={() => setTick(tick + 1)}>Refresh</button>
      </div>
      <section>
        <h4 style={{ margin: '0 0 6px' }}>Uncommitted files ({g.files.length})</h4>
        {g.files.length === 0 ? (
          <div className="muted small">Working tree is clean.</div>
        ) : (
          <table className="history">
            <tbody>
              {g.files.map((f) => (
                <tr key={f.path}>
                  <td className="nowrap" style={{ width: 1 }}><span className={`badge ${f.status === '??' ? 'info' : 'warn'}`}>{STATUS[f.status] ?? f.status.trim()}</span></td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>{f.path}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section>
        <h4 style={{ margin: '0 0 6px' }}>Stash — {plural(g.stashes.length, 'entry', 'entries')}, {plural(g.stashFileCount, 'file')}</h4>
        {g.stashes.length === 0 && <div className="muted small">Nothing stashed.</div>}
        {g.stashes.map((st) => (
          <details key={st.ref} style={{ marginBottom: 4 }}>
            <summary className="small">
              <code>{st.ref}</code> {st.message} <span className="muted">({plural(st.files.length, 'file')})</span>
            </summary>
            <ul style={{ margin: '4px 0 6px', paddingLeft: 22, fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>
              {st.files.map((f) => <li key={f}>{f}</li>)}
            </ul>
          </details>
        ))}
      </section>
    </div>
  );
}

export function ServicesPage() {
  const { rows, error, setError, refresh, act } = useServices();
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('logs');

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
  const current = rows.find((r) => r.name === selected);
  const open = (name: string, t: Tab) => {
    setSelected(name);
    setTab(t);
  };

  const controls = (r: ServiceView) => {
    const canStart = r.state === 'down' && !r.job;
    const canStop = (r.state === 'up' || r.state === 'starting') && !r.job;
    const canStopExternal = r.state === 'external' && !r.job && !!r.externalPid;
    return (
      <>
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
      </>
    );
  };

  const gitCell = (r: ServiceView) =>
    r.git ? (
      <div className="small" title={r.git.branch ?? ''}>
        <button className="link small" onClick={() => open(r.name, 'git')}>
          {r.git.dirty} uncommitted · stash {r.git.stashes} ({plural(r.git.stashFiles, 'file')})
        </button>
        <div className="muted">{r.git.branch ?? '(detached)'}</div>
      </div>
    ) : (
      <span className="muted small">—</span>
    );

  if (current) {
    const b = badge(current);
    return (
      <div className="page">
        {error && <div className="notice error">{error}</div>}
        <div className="section-head">
          <button className="ghost small" onClick={() => setSelected(null)}>← All services</button>
          <h2>{current.name}</h2>
          <span className={`badge ${b.cls}`}>{b.text}</span>
          {current.groups.map((g) => <span key={g} className="badge info">{g}</span>)}
          <span className="spacer" />
          <button className="ghost small" onClick={() => void refresh(true)} title="Re-read status, branch and git counts now">Refresh</button>
          {controls(current)}
        </div>
        {current.error && (
          <div className="notice error">
            {current.error} <button className="link small" onClick={() => void act(() => api.dismissServiceError(current.name))}>Dismiss</button>
          </div>
        )}
        <div className="svc-layout">
          <div className="svc-list" role="list" aria-label="Services">
            {rows.map((r) => {
              const rb = badge(r);
              return (
                <button key={r.name} className={r.name === current.name ? 'on' : ''} onClick={() => setSelected(r.name)} role="listitem">
                  <span><span className={`dot ${rb.cls}`} aria-hidden />{r.name}</span>
                  <span className="muted small">:{r.port}{r.groups.length ? ` · ${r.groups.join(', ')}` : ''}</span>
                </button>
              );
            })}
          </div>
          <div>
            <BranchSwitcher s={current} act={act} />
            <div className="tabs" role="tablist">
              <button className={tab === 'logs' ? 'on' : ''} role="tab" aria-selected={tab === 'logs'} onClick={() => setTab('logs')}>Logs</button>
              <button className={tab === 'git' ? 'on' : ''} role="tab" aria-selected={tab === 'git'} onClick={() => setTab('git')}>
                Uncommitted files{current.git ? ` (${current.git.dirty})` : ''}{current.git && current.git.stashes ? ` · stash ${current.git.stashes}` : ''}
              </button>
              <button className={tab === 'config' ? 'on' : ''} role="tab" aria-selected={tab === 'config'} onClick={() => setTab('config')}>Config</button>
            </div>
            {tab === 'logs' && <LogView key={current.name} name={current.name} />}
            {tab === 'git' && <GitView key={current.name} name={current.name} />}
            {tab === 'config' && <Config key={`${current.name}:${current.cwd}:${current.command}`} s={current} onChanged={refresh} onError={setError} />}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      {error && <div className="notice error">{error}</div>}
      <div className="section-head">
        <h2>Services</h2>
        <span className="spacer" />
        <button className="ghost small" onClick={() => void refresh(true)}>Refresh</button>
        <button className="small" disabled={busy || !anyDown} onClick={() => act(() => api.servicesUp([]))}>Start all down</button>
        <button className="ghost small" disabled={busy || !anyManaged} onClick={() => act(() => api.servicesDown([]))}>Stop all</button>
      </div>
      <table className="history">
        <thead>
          <tr>
            <th>Service</th>
            <th>Group</th>
            <th>State</th>
            <th>Port</th>
            <th>Needs</th>
            <th>Git</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const b = badge(r);
            return (
              <tr key={r.name}>
                <td>
                  <button className="link" onClick={() => open(r.name, 'logs')}><strong>{r.name}</strong></button>
                  {r.description && <div className="muted small">{r.description}</div>}
                  {r.error && <div className="small" style={{ color: 'var(--danger)' }}>{r.error}</div>}
                </td>
                <td>{r.groups.length ? r.groups.map((g) => <span key={g} className="badge info" style={{ marginRight: 4 }}>{g}</span>) : <span className="muted small">—</span>}</td>
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
                <td>{gitCell(r)}</td>
                <td className="row-actions">
                  {controls(r)}
                  <button className="link small" onClick={() => open(r.name, 'logs')}>Logs</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted small">Click a service for its logs, uncommitted files and config. Starting a service starts only what it needs that is not already up. Stop on a service started elsewhere ends only the process listening on its port; Start then runs it under tidy.</p>
    </div>
  );
}
