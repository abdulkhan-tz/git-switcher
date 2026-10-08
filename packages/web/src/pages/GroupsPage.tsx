import { useServices } from '../components/useServices';
import { api } from '../api';

export function GroupsPage() {
  const { rows, groups, error, refresh, act } = useServices();
  if (!rows) return error ? <div className="notice error">{error}</div> : <div className="muted">Loading…</div>;

  const state = (n: string) => rows.find((r) => r.name === n)?.state ?? 'down';
  const busy = rows.some((r) => r.job);
  const save = (name: string, members: string[]) => act(() => api.setServiceGroup(name, members));

  const create = async () => {
    const name = prompt('Group name')?.trim();
    if (!name || !rows[0]) return;
    await save(name, [rows[0].name]);
  };
  const rename = async (from: string) => {
    const to = prompt(`New name for the group ${from}`, from)?.trim();
    if (to && to !== from) await act(() => api.renameServiceGroup(from, to));
  };

  return (
    <div className="page">
      {error && <div className="notice error">{error}</div>}
      <div className="section-head">
        <h2>Groups</h2>
        <span className="spacer" />
        <button className="ghost small" onClick={() => void create()}>New group</button>
        <button className="ghost small" onClick={() => void refresh(true)}>Refresh</button>
      </div>
      <p className="muted small">A group starts several services in a fixed order, top to bottom, and stops them in reverse. A service's own dependencies are started before it, only if they are not already up.</p>
      {groups.length === 0 && <div className="empty">No groups yet. Create one, then add services and set the order.</div>}
      {groups.map((g) => {
        const missing = g.members.filter((m) => state(m) === 'down');
        const addable = rows.filter((r) => !g.members.includes(r.name));
        const move = (i: number, d: number) => {
          const m = [...g.members];
          [m[i], m[i + d]] = [m[i + d]!, m[i]!];
          void save(g.name, m);
        };
        return (
          <div key={g.name} className="card">
            <div className="section-head" style={{ marginBottom: 6 }}>
              <strong>{g.name}</strong>
              <button className="link small" onClick={() => void rename(g.name)}>Rename</button>
              <span className="muted small">{missing.length === 0 ? 'all up' : `${missing.length} of ${g.members.length} down`}</span>
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
              <select value="" onChange={(e) => e.target.value && void save(g.name, [...g.members, e.target.value])} aria-label={`Add a service to ${g.name}`} style={{ marginTop: 6 }}>
                <option value="">+ add service…</option>
                {addable.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
              </select>
            )}
          </div>
        );
      })}
    </div>
  );
}
