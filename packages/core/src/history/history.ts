import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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
}
