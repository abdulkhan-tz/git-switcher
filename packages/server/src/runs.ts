import { randomBytes } from 'node:crypto';
import { History, switchBranch, type PromptRequest, type RepoEntry, type RunResult, type StepEvent } from '@gsw/core';

export type RunEvent =
  | { type: 'step'; repoId: string; event: StepEvent }
  | { type: 'prompt'; repoId: string; promptId: string; request: PromptRequest }
  | { type: 'answered'; promptId: string; answer: boolean }
  | { type: 'result'; repoId: string; result: RunResult }
  | { type: 'done'; results: RunResult[] };

/** One multi-repo switch. Keeps every event so a late subscriber gets a full replay. */
export class Batch {
  readonly id = randomBytes(6).toString('hex');
  readonly events: RunEvent[] = [];
  private listeners = new Set<(e: RunEvent) => void>();
  private pending = new Map<string, (answer: boolean) => void>();
  done = false;

  constructor(
    readonly branch: string,
    readonly repos: RepoEntry[],
  ) {}

  subscribe(listener: (e: RunEvent) => void): () => void {
    for (const e of this.events) listener(e);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: RunEvent): void {
    this.events.push(e);
    for (const l of this.listeners) l(e);
  }

  answer(promptId: string, answer: boolean): boolean {
    const resolve = this.pending.get(promptId);
    if (!resolve) return false;
    this.pending.delete(promptId);
    this.emit({ type: 'answered', promptId, answer });
    resolve(answer);
    return true;
  }

  /** Declines every open prompt; each run then ends as "cancelled" before touching the repo. */
  cancel(): void {
    for (const id of [...this.pending.keys()]) this.answer(id, false);
  }

  async run(history: History, base?: string): Promise<RunResult[]> {
    const results: RunResult[] = [];
    for (const repo of this.repos) {
      const prompter = (request: PromptRequest) =>
        new Promise<boolean>((resolve) => {
          const promptId = randomBytes(4).toString('hex');
          this.pending.set(promptId, resolve);
          this.emit({ type: 'prompt', repoId: repo.id, promptId, request });
        });
      const result = await switchBranch(
        repo.path,
        this.branch,
        { remote: repo.remote, base: base || repo.base },
        prompter,
        (event) => this.emit({ type: 'step', repoId: repo.id, event }),
      );
      history.append(result);
      results.push(result);
      this.emit({ type: 'result', repoId: repo.id, result });
    }
    this.done = true;
    this.emit({ type: 'done', results });
    return results;
  }
}
