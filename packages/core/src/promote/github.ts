import { execFile } from 'node:child_process';
import type { PullRequest } from './types.js';

export interface Comparison {
  aheadBy: number;
  /** First line of each commit message, oldest first. */
  subjects: string[];
}

/** Everything the promotion engine needs from GitHub. */
export interface GitHubClient {
  repoSlug(repoPath: string): Promise<string>;
  compare(slug: string, base: string, head: string): Promise<Comparison>;
  findOpenPr(slug: string, base: string, head: string): Promise<PullRequest | null>;
  createPr(slug: string, pr: { base: string; head: string; title: string; body: string }): Promise<PullRequest>;
  getPr(slug: string, number: number): Promise<PullRequest>;
  enableAutoMerge(slug: string, number: number): Promise<void>;
}

export class GhError extends Error {}

function gh(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (error, stdout, stderr) => {
      if (error) {
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
        reject(new GhError(missing ? 'GitHub CLI `gh` is not installed or not on PATH' : `gh ${args.slice(0, 2).join(' ')} failed: ${(String(stderr) || error.message).trim()}`));
      } else resolve(String(stdout));
    });
  });
}

const PR_FIELDS = 'number,url,state';
const enc = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');

/** GitHubClient backed by the user's `gh` login; the app stores no tokens. */
export class GhClient implements GitHubClient {
  async repoSlug(repoPath: string): Promise<string> {
    return (await gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], repoPath)).trim();
  }

  async compare(slug: string, base: string, head: string): Promise<Comparison> {
    const out = await gh(['api', `repos/${slug}/compare/${enc(base)}...${enc(head)}`, '--jq', '{aheadBy: .ahead_by, subjects: [.commits[].commit.message | split("\\n")[0]]}']);
    return JSON.parse(out) as Comparison;
  }

  async findOpenPr(slug: string, base: string, head: string): Promise<PullRequest | null> {
    const out = await gh(['pr', 'list', '-R', slug, '--base', base, '--head', head, '--state', 'open', '--json', PR_FIELDS, '--limit', '1']);
    return (JSON.parse(out) as PullRequest[])[0] ?? null;
  }

  async createPr(slug: string, pr: { base: string; head: string; title: string; body: string }): Promise<PullRequest> {
    const url = (await gh(['pr', 'create', '-R', slug, '--base', pr.base, '--head', pr.head, '--title', pr.title, '--body', pr.body])).trim().split('\n').pop()!;
    return JSON.parse(await gh(['pr', 'view', url, '--json', PR_FIELDS])) as PullRequest;
  }

  async getPr(slug: string, number: number): Promise<PullRequest> {
    return JSON.parse(await gh(['pr', 'view', String(number), '-R', slug, '--json', PR_FIELDS])) as PullRequest;
  }

  async enableAutoMerge(slug: string, number: number): Promise<void> {
    await gh(['pr', 'merge', String(number), '-R', slug, '--auto', '--merge']);
  }
}
