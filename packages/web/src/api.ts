import type { Group, HistoryEntry, RepoEntry, RepoState, WorktreeDetails } from '@git-helper/core';
import type { RunEvent } from '@git-helper/server';

export type { RunEvent };

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
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText);
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  hasToken: () => token.length > 0,
  repos: () => call<RepoView[]>('GET', '/repos'),
  repo: (id: string) => call<RepoView>('GET', `/repos/${enc(id)}`),
  addRepo: (body: { path: string; name?: string; base?: string; remote?: string }) => call<RepoView>('POST', '/repos', body),
  updateRepo: (id: string, body: { name?: string; base?: string; remote?: string }) => call<RepoView>('PATCH', `/repos/${enc(id)}`, body),
  removeRepo: (id: string) => call<RepoEntry>('DELETE', `/repos/${enc(id)}`),
  worktrees: (id: string) => call<WorktreeDetails[]>('GET', `/repos/${enc(id)}/worktrees`),
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
