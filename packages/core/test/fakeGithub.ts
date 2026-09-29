import type { Comparison, GitHubClient, PullRequest } from '../src/index.js';

interface FakePr extends PullRequest {
  base: string;
  head: string;
  title: string;
  body: string;
  autoMerge: boolean;
}

/** In-memory GitHub: branches are commit lists; merging a PR copies head's commits into base. */
export class FakeGitHub implements GitHubClient {
  branches = new Map<string, string[]>();
  prs: FakePr[] = [];
  calls: string[] = [];
  failNext: Partial<Record<keyof GitHubClient, string>> = {};
  autoMergeError: string | null = null;

  constructor(branches: Record<string, string[]>) {
    for (const [k, v] of Object.entries(branches)) this.branches.set(k, [...v]);
  }

  private guard(op: keyof GitHubClient) {
    this.calls.push(op);
    const msg = this.failNext[op];
    if (msg) {
      delete this.failNext[op];
      throw new Error(msg);
    }
  }

  private branch(name: string): string[] {
    const b = this.branches.get(name);
    if (!b) throw new Error(`gh api compare failed: HTTP 404 branch ${name} not found`);
    return b;
  }

  async repoSlug(): Promise<string> {
    this.guard('repoSlug');
    return 'acme/api';
  }

  async compare(_slug: string, base: string, head: string): Promise<Comparison> {
    this.guard('compare');
    const inBase = new Set(this.branch(base));
    const ahead = this.branch(head).filter((c) => !inBase.has(c));
    return { aheadBy: ahead.length, subjects: ahead.map((c) => `commit ${c}`) };
  }

  async findOpenPr(_slug: string, base: string, head: string): Promise<PullRequest | null> {
    this.guard('findOpenPr');
    const pr = this.prs.find((p) => p.base === base && p.head === head && p.state === 'OPEN');
    return pr ? this.view(pr) : null;
  }

  async createPr(_slug: string, pr: { base: string; head: string; title: string; body: string }): Promise<PullRequest> {
    this.guard('createPr');
    if (this.prs.some((p) => p.base === pr.base && p.head === pr.head && p.state === 'OPEN')) throw new Error('a pull request already exists');
    const number = this.prs.length + 1;
    const created: FakePr = { ...pr, number, url: `https://github.com/acme/api/pull/${number}`, state: 'OPEN', autoMerge: false };
    this.prs.push(created);
    return this.view(created);
  }

  async getPr(_slug: string, number: number): Promise<PullRequest> {
    this.guard('getPr');
    return this.view(this.pr(number));
  }

  async enableAutoMerge(_slug: string, number: number): Promise<void> {
    this.guard('enableAutoMerge');
    if (this.autoMergeError) throw new Error(this.autoMergeError);
    this.pr(number).autoMerge = true;
  }

  pr(number: number): FakePr {
    const pr = this.prs.find((p) => p.number === number);
    if (!pr) throw new Error(`no PR ${number}`);
    return pr;
  }

  /** What a human does on GitHub. */
  merge(number: number): void {
    const pr = this.pr(number);
    const base = this.branch(pr.base);
    for (const c of this.branch(pr.head)) if (!base.includes(c)) base.push(c);
    pr.state = 'MERGED';
  }

  close(number: number): void {
    this.pr(number).state = 'CLOSED';
  }

  reopen(number: number): void {
    this.pr(number).state = 'OPEN';
  }

  private view(pr: FakePr): PullRequest {
    return { number: pr.number, url: pr.url, state: pr.state };
  }
}
