import { newRunId, switchBranch } from './run.js';
import type { Prompter, RunResult, StepEvent, SwitchOptions } from './types.js';

export interface ManyTarget {
  path: string;
  options?: SwitchOptions;
}

/** Runs the same switch on each repo in order. A failure in one never stops or rolls back another. */
export async function switchMany(
  targets: ManyTarget[],
  branch: string,
  prompter: Prompter,
  onEvent?: (event: StepEvent) => void,
  onResult?: (result: RunResult) => void,
): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (const target of targets) {
    const result = await switchBranch(target.path, branch, { runId: newRunId(), ...target.options }, prompter, onEvent);
    results.push(result);
    onResult?.(result);
  }
  return results;
}
