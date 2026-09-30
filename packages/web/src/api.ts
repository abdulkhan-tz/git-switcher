import type { Group, HistoryEntry, Promotion, RepoEntry, RepoState, Settings, WorkerStatus, WorktreeDetails } from '@git-helper/core';
import type { RunEvent } from '@git-helper/server';

export type { RunEvent };

export type { Promotion };

export interface PromotionsView {
  promotions: Promotion[];
  worker: WorkerStatus;
}

export type RepoView = RepoEntry & { missing: boolean; state: RepoState | null; error: string | null };

// The token arrives once in the URL (?token=…); keep it for reloads, then drop it from the address bar.
const TOKEN_KEY = 'git-helper-token';
function readToken(): string {
  const fromUrl = new URLSearchParams(location.search).get('token');
  try {
    if (fromUrl) {
      sessionStorage.setItem(TOKEN_KEY, fromUrl);
      history.replaceState(null, '', location.pathname + location.hash);
    }
    return fromUrl ?? sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return fromUrl ?? '';
  }
}
const token = readToken();

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'x-git-helper-token': token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = data as { error?: string; errors?: { repo: string; error: string }[] };
    throw new ApiError(res.status, d.error ?? d.errors?.map((e) => `${e.repo}: ${e.error}`).join('; ') ?? res.statusText);
  }
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  hasToken: () => token.length > 0,
  version: () => call<{ stale: boolean }>('GET', '/version'),
  repos: () => call<RepoView[]>('GET', '/repos'),
  repo: (id: string) => call<RepoView>('GET', `/repos/${enc(id)}`),
  addRepo: (body: { path: string; name?: string; base?: string; remote?: string }) => call<RepoView>('POST', '/repos', body),
  updateRepo: (id: string, body: { name?: string; base?: string; remote?: string }) => call<RepoView>('PATCH', `/repos/${enc(id)}`, body),
  removeRepo: (id: string) => call<RepoEntry>('DELETE', `/repos/${enc(id)}`),
  worktrees: (id: string) => call<WorktreeDetails[]>('GET', `/repos/${enc(id)}/worktrees`),
  setPipeline: (id: string, stages: string[], autoMerge: string[]) => call<RepoView>('PUT', `/repos/${enc(id)}/pipeline`, { stages, autoMerge }),
  clearPipeline: (id: string) => call<RepoView>('DELETE', `/repos/${enc(id)}/pipeline`),
  promotions: () => call<PromotionsView>('GET', '/promotions'),
  startPromotions: (repoIds: string[], from?: string) =>
    call<{ started: Promotion[]; errors: { repo: string; error: string }[] }>('POST', '/promotions', { repoIds, from }),
  stopPromotion: (id: string) => call<Promotion>('POST', `/promotions/${enc(id)}/stop`),
  resumePromotion: (id: string) => call<Promotion>('POST', `/promotions/${enc(id)}/resume`),
  checkPromotions: () => call<WorkerStatus>('POST', '/promotions/tick'),
  deletePromotion: (id: string) => call<Promotion>('DELETE', `/promotions/${enc(id)}`),
  clearFinishedPromotions: () => call<{ removed: number }>('DELETE', '/promotions'),
  setIntervalSec: (sec: number) => call<{ settings: Settings; worker: WorkerStatus }>('PUT', '/settings', { promotionIntervalSec: sec }),
  deleteHistoryEntry: (runId: string) => call<{ removed: number }>('DELETE', `/history/${enc(runId)}`),
  clearHistory: () => call<{ removed: number }>('DELETE', '/history'),
  groups: () => call<Group[]>('GET', '/groups'),
  setGroup: (name: string, repoIds: string[]) => call<Group>('PUT', `/groups/${enc(name)}`, { repoIds }),
  removeGroup: (name: string) => call<{ ok: true }>('DELETE', `/groups/${enc(name)}`),
  history: (repo?: string) => call<HistoryEntry[]>('GET', `/history${repo ? `?repo=${enc(repo)}` : ''}`),
  startSwitch: (repoIds: string[], branch: string, base?: string) => call<{ runId: string }>('POST', '/switch', { repoIds, branch, base }),
  answer: (runId: string, promptId: string, answer: boolean) => call<{ ok: true }>('POST', `/runs/${runId}/answer`, { promptId, answer }),
  cancel: (runId: string) => call<{ ok: true }>('POST', `/runs/${runId}/cancel`),
  events: (runId: string, onEvent: (e: RunEvent) => void): (() => void) => {
    const source = new EventSource(`/api/runs/${runId}/events?token=${enc(token)}`);
    source.onmessage = (m) => onEvent(JSON.parse(m.data) as RunEvent);
    return () => source.close();
  },
};
