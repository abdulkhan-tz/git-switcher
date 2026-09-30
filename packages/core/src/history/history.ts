import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configDir } from '../paths.js';
import type { RunResult, Step, StepStatus } from '../switch/types.js';

export type HistoryEntry = Omit<RunResult, 'events'> & { steps: { step: Step; status: StepStatus; message: string }[] };

export class History {
  constructor(readonly file: string = join(configDir(), 'history.jsonl')) {}

  append(result: RunResult): HistoryEntry {
    const { events, ...rest } = result;
    const entry: HistoryEntry = {
      ...rest,
      steps: events.filter((e) => e.status !== 'start').map(({ step, status, message }) => ({ step, status, message })),
    };
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify(entry) + '\n');
    return entry;
  }

  /** Newest first. */
  list(filter: { repo?: string; limit?: number } = {}): HistoryEntry[] {
    if (!existsSync(this.file)) return [];
    const entries = readFileSync(this.file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as HistoryEntry];
        } catch {
          return [];
        }
      })
      .filter((e) => !filter.repo || e.repo === filter.repo)
      .reverse();
    return filter.limit ? entries.slice(0, filter.limit) : entries;
  }

  private rewrite(keep: (e: HistoryEntry) => boolean): number {
    if (!existsSync(this.file)) return 0;
    const all = this.list().reverse(); // oldest first, as stored
    const kept = all.filter(keep);
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, kept.map((e) => JSON.stringify(e) + '\n').join(''));
    renameSync(tmp, this.file);
    return all.length - kept.length;
  }

  /** Deletes one entry by run id (a unique prefix is enough). Returns whether one was removed. */
  remove(runId: string): boolean {
    const matches = this.list().filter((e) => e.runId === runId || e.runId.startsWith(runId));
    if (matches.length !== 1) return false;
    return this.rewrite((e) => e.runId !== matches[0]!.runId) === 1;
  }

  /** Deletes every entry, or only one repo's. Returns how many were removed. */
  clear(filter: { repo?: string } = {}): number {
    return this.rewrite((e) => (filter.repo ? e.repo !== filter.repo : false));
  }
}
