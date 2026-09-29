import { useState } from 'react';
import { api, type RepoView } from '../api';

const key = (a: string, b: string) => `${a}→${b}`;

/** Inline editor for a repo's promotion stages and which steps auto-merge. */
export function PipelineEditor({ repo, onSaved, onCancel, onError }: { repo: RepoView; onSaved(): void; onCancel(): void; onError(m: string): void }) {
  const [text, setText] = useState((repo.pipeline?.stages ?? []).join(', '));
  const [auto, setAuto] = useState<Set<string>>(new Set(repo.pipeline?.autoMerge ?? []));
  const stages = text.split(/[,\s→>]+/).map((s) => s.trim()).filter(Boolean);
  const steps = stages.slice(0, -1).map((s, i) => [s, stages[i + 1]!] as const);

  const save = async () => {
    try {
      if (stages.length === 0) await api.clearPipeline(repo.id);
      else await api.setPipeline(repo.id, stages, steps.map(([a, b]) => key(a, b)).filter((k) => auto.has(k)));
      onSaved();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <div className="pipeline-editor">
      <label className="small muted" htmlFor={`stages-${repo.id}`}>Stages, in promotion order</label>
      <input id={`stages-${repo.id}`} value={text} onChange={(e) => setText(e.target.value)} placeholder="develop, qa, stage, main" />
      {steps.length > 0 && (
        <div className="auto-merge">
          <span className="small muted">Auto-merge (merge commit, once checks pass):</span>
          {steps.map(([a, b]) => (
            <label key={key(a, b)} className="small">
              <input
                type="checkbox"
                checked={auto.has(key(a, b))}
                onChange={() =>
                  setAuto((s) => {
                    const n = new Set(s);
                    if (n.has(key(a, b))) n.delete(key(a, b));
                    else n.add(key(a, b));
                    return n;
                  })
                }
              />{' '}
              {a} → {b}
            </label>
          ))}
        </div>
      )}
      <div className="row">
        <button className="primary small" onClick={save}>{stages.length === 0 ? 'Remove pipeline' : 'Save pipeline'}</button>
        <button className="ghost small" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
