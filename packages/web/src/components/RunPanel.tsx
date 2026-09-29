import { useEffect, useState } from 'react';
import type { PromptRequest, RunResult, StepEvent } from '@gsw/core';
import { api, type RepoView, type RunEvent } from '../api';
import { PromptDialog } from './PromptDialog';

interface RepoProgress {
  steps: StepEvent[];
  result?: RunResult;
}

interface Props {
  runId: string;
  branch: string;
  repos: RepoView[];
  onDone(): void;
  onClose(): void;
}

export function RunPanel({ runId, branch, repos, onDone, onClose }: Props) {
  const [progress, setProgress] = useState<Record<string, RepoProgress>>({});
  const [prompts, setPrompts] = useState<{ promptId: string; repoId: string; request: PromptRequest }[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setProgress({});
    setPrompts([]);
    setDone(false);
    return api.events(runId, (e: RunEvent) => {
      switch (e.type) {
        case 'step':
          if (e.event.status === 'start') return;
          setProgress((p) => ({ ...p, [e.repoId]: { ...p[e.repoId], steps: [...(p[e.repoId]?.steps ?? []), e.event] } }));
          break;
        case 'prompt':
          setPrompts((q) => [...q, { promptId: e.promptId, repoId: e.repoId, request: e.request }]);
          break;
        case 'answered':
          setPrompts((q) => q.filter((x) => x.promptId !== e.promptId));
          break;
        case 'result':
          setProgress((p) => ({ ...p, [e.repoId]: { steps: p[e.repoId]?.steps ?? [], result: e.result } }));
          break;
        case 'done':
          setDone(true);
          onDone();
          break;
      }
    });
  }, [runId]);

  const nameOf = (id: string) => repos.find((r) => r.id === id)?.name ?? id;
  const prompt = prompts[0];

  return (
    <section className="run-panel" aria-live="polite">
      <header>
        <h2>
          Switching to <code>{branch}</code>
        </h2>
        <span className="spacer" />
        {!done && <button className="ghost" onClick={() => api.cancel(runId)} title="Declines any pending question; runs already past their questions finish">Cancel pending</button>}
        {done && <button onClick={onClose}>Close</button>}
      </header>
      <div className="run-repos">
        {repos.map((r) => {
          const p = progress[r.id];
          const res = p?.result;
          return (
            <div key={r.id} className={`run-repo ${res?.outcome ?? (p ? 'running' : 'queued')}`}>
              <div className="run-repo-head">
                <strong>{r.name}</strong>
                <span className={`badge ${res?.outcome === 'switched' ? 'ok' : res?.outcome === 'failed' ? 'danger' : res ? 'warn' : 'info'}`}>
                  {res ? (res.outcome === 'failed' ? `failed at ${res.failedStep}` : res.outcome) : p ? 'running' : 'queued'}
                </span>
              </div>
              <ol className="steps">
                {(p?.steps ?? []).map((s, i) => (
                  <li key={i} className={s.status}>
                    <span className="mark">{s.status === 'ok' ? '✓' : s.status === 'skip' ? '–' : '✗'}</span>
                    <span className="step-name">{s.step}</span>
                    <span className="step-msg">{s.message}</span>
                  </li>
                ))}
              </ol>
              {res?.recovery && <pre className="recovery">{res.recovery}</pre>}
            </div>
          );
        })}
      </div>
      {prompt && (
        <PromptDialog
          key={prompt.promptId}
          repoName={nameOf(prompt.repoId)}
          request={prompt.request}
          onAnswer={(answer) => void api.answer(runId, prompt.promptId, answer).catch(() => {})}
        />
      )}
    </section>
  );
}
