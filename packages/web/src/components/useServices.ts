import { useCallback, useEffect, useState } from 'react';
import type { ServiceGroup } from '@tidy/core';
import { api, type ServiceView } from '../api';
import { toast } from './Toast';

const REFRESH_MS = 3000;

export function badge(s: ServiceView): { cls: string; text: string } {
  if (s.job === 'starting' || s.state === 'starting') return { cls: 'warn', text: 'starting…' };
  if (s.job === 'switching') return { cls: 'warn', text: 'switching branch…' };
  if (s.job === 'stopping') return { cls: 'warn', text: 'stopping…' };
  if (s.state === 'up') return { cls: 'ok', text: 'up' };
  if (s.state === 'external') return { cls: 'info', text: 'up — started elsewhere' };
  return { cls: '', text: 'down' };
}

/** Services and groups, refreshed every few seconds, plus an `act` that runs a change then reloads. */
export function useServices() {
  const [rows, setRows] = useState<ServiceView[] | null>(null);
  const [groups, setGroups] = useState<ServiceGroup[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (fresh = false) => {
    try {
      const [r, g] = await Promise.all([api.services(fresh), api.serviceGroups()]);
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

  /** Runs a change, tells the user how it went, then reloads. `done` is the success message. */
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      if (done) toast(done);
    } catch (e) {
      setError((e as Error).message);
      toast((e as Error).message, 'error');
    }
    await refresh();
  };

  return { rows, groups, error, setError, refresh, act };
}

/** Lightweight up/total count for the sidebar; the Services page does its own, fuller polling. */
export function useServiceCount() {
  const [n, setN] = useState<{ up: number; total: number } | null>(null);
  useEffect(() => {
    if (!api.hasToken()) return;
    let alive = true;
    const load = () =>
      api.services().then(
        (r) => alive && setN({ up: r.filter((s) => s.state === 'up' || s.state === 'external').length, total: r.length }),
        () => {},
      );
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return n && n.total > 0 ? n : null;
}
