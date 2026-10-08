import { Skeleton } from '../components/Skeleton';
import { useCallback, useEffect, useState } from 'react';
import type { Group } from '@tidy/core';
import { api, type RepoView } from '../api';
import { AddRepo } from '../components/AddRepo';
import { RepoCard } from '../components/RepoCard';
import { RunPanel } from '../components/RunPanel';
import { SwitchBar } from '../components/SwitchBar';

export function ReposPage() {
  const [repos, setRepos] = useState<RepoView[] | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [run, setRun] = useState<{ runId: string; branch: string; repoIds: string[]; done: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [r, g] = await Promise.all([api.repos(), api.groups()]);
      setRepos(r);
      setGroups(g);
      setSelected((s) => new Set([...s].filter((id) => r.some((x) => x.id === id))));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // #/repos?group=<name> (used by the tray menu) preselects that group once groups have loaded.
  const [wantedGroup, setWantedGroup] = useState(() => new URLSearchParams(location.hash.split('?')[1] ?? '').get('group'));
  useEffect(() => {
    const g = wantedGroup && groups.find((x) => x.name === wantedGroup);
    if (!g) return;
    setSelected(new Set(g.repoIds));
    setWantedGroup(null);
  }, [groups, wantedGroup]);

  useEffect(() => {
    const onHash = () => setWantedGroup(new URLSearchParams(location.hash.split('?')[1] ?? '').get('group'));
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    addEventListener('focus', onFocus);
    return () => removeEventListener('focus', onFocus);
  }, [refresh]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const startSwitch = async (branch: string, base?: string) => {
    // Keep registry order, which is also the order the server runs them in.
    const repoIds = (repos ?? []).filter((r) => selected.has(r.id)).map((r) => r.id);
    try {
      setError(null);
      const { runId } = await api.startSwitch(repoIds, branch, base);
      setRun({ runId, branch, repoIds, done: false });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const guard = (fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const busyIds = run && !run.done ? new Set(run.repoIds) : new Set<string>();

  return (
    <div className="page">
      <SwitchBar
        groups={groups}
        selectedCount={selected.size}
        running={!!run && !run.done}
        onSelectGroup={(g) => setSelected(new Set(g.repoIds))}
        onSelectAll={(all) => setSelected(all ? new Set((repos ?? []).filter((r) => !r.missing).map((r) => r.id)) : new Set())}
        onSaveGroup={(name) => void guard(() => api.setGroup(name, [...selected]))()}
        onDeleteGroup={(name) => void guard(() => api.removeGroup(name))()}
        onSwitch={startSwitch}
      />

      {error && (
        <div className="notice error" role="alert">
          {error} <button className="link" onClick={() => setError(null)}>dismiss</button>
        </div>
      )}

      {run && (
        <RunPanel
          runId={run.runId}
          branch={run.branch}
          repos={(repos ?? []).filter((r) => run.repoIds.includes(r.id))}
          onDone={() => {
            setRun((r) => (r ? { ...r, done: true } : r));
            void refresh();
          }}
          onClose={() => setRun(null)}
        />
      )}

      <div className="section-head">
        <h2>Repositories</h2>
        <span className="spacer" />
        <button className="ghost" onClick={() => void refresh()}>Refresh</button>
        <AddRepo onAdded={() => void refresh()} onError={setError} />
      </div>

      {repos === null ? (
        <Skeleton rows={4} />
      ) : repos.length === 0 ? (
        <div className="empty">
          <p>No repos registered yet.</p>
          <p className="muted">Add one above, or run <code>git-tidy add /path/to/repo</code>.</p>
        </div>
      ) : (
        <div className="rows">
          {repos.map((r) => (
            <RepoCard
              key={r.id + (r.base ?? '')}
              repo={r}
              selected={selected.has(r.id)}
              busy={busyIds.has(r.id)}
              onToggle={() => toggle(r.id)}
              onChanged={() => void refresh()}
              onError={setError}
            />
          ))}
        </div>
      )}
    </div>
  );
}
