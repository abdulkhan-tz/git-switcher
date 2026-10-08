import { useCallback, useEffect, useState } from 'react';
import type { ServiceGroup } from '@tidy/core';
import { api, type ServiceView } from '../api';

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

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
    await refresh();
  };

  return { rows, groups, error, setError, refresh, act };
}
