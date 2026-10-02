import { useEffect, useState } from 'react';
import type { WorkerStatus } from '@git-helper/core';
import { api } from '../api';

const MIN = 1;
const MAX = 60;

/** Shows who polls GitHub, a live countdown to the next check, and the 1–60 s interval control. */
export function CheckTimer({ worker, onChanged, onError }: { worker: WorkerStatus; onChanged(): void; onError(m: string): void }) {
  const [now, setNow] = useState(Date.now());
  const [draft, setDraft] = useState(Math.round(worker.intervalMs / 1000));
  const [busy, setBusy] = useState(false);

  useEffect(() => setDraft(Math.round(worker.intervalMs / 1000)), [worker.intervalMs]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  const next = worker.nextCheckAt ? new Date(worker.nextCheckAt).getTime() : null;
  const left = next === null ? null : Math.max(0, Math.ceil((next - now) / 1000));
  const running = worker.polling || worker.holder !== null;
  const secs = Math.round(worker.intervalMs / 1000);

  const save = async (sec: number) => {
    if (sec === secs || sec < MIN || sec > MAX) return;
    setBusy(true);
    try {
      await api.setIntervalSec(sec);
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    setBusy(true);
    try {
      await api.setChecksEnabled(worker.paused);
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const checkNow = async () => {
    setBusy(true);
    try {
      await api.checkPromotions();
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="check-timer">
      <label className="checks-toggle small">
        <input type="checkbox" role="switch" checked={!worker.paused} onChange={toggle} disabled={busy} aria-label="Check promotions" />
        <span>Check promotions</span>
      </label>
      <div className="countdown" aria-live="off">
        {worker.paused ? (
          <span className="badge warn">paused — no GitHub checks; running promotions wait</span>
        ) : !running ? (
          <span className="muted">No worker is polling — start the tray app or <code>git-helper ui</code>.</span>
        ) : worker.checking || left === 0 ? (
          <span className="badge info">checking GitHub…</span>
        ) : left !== null ? (
          <>
            <span className="muted small">next check in</span> <strong className="count">{left}s</strong>
            <span className="progress" aria-hidden>
              <span style={{ width: `${Math.min(100, (left / secs) * 100)}%` }} />
            </span>
          </>
        ) : (
          <span className="muted small">waiting for the first check…</span>
        )}
        <button className="link small" onClick={checkNow} disabled={busy}>Check now</button>
      </div>
      <label className={`interval small ${worker.paused ? 'dim' : ''}`}>
        <span className="muted">Check every</span>
        <input
          type="range"
          min={MIN}
          max={MAX}
          value={draft}
          onChange={(e) => setDraft(Number(e.target.value))}
          onMouseUp={() => void save(draft)}
          onKeyUp={() => void save(draft)}
          onTouchEnd={() => void save(draft)}
          aria-label="Check interval in seconds"
          disabled={busy}
        />
        <input
          type="number"
          min={MIN}
          max={MAX}
          value={draft}
          onChange={(e) => setDraft(Number(e.target.value))}
          onBlur={() => void save(draft)}
          onKeyDown={(e) => e.key === 'Enter' && void save(draft)}
          className="interval-num"
          aria-label="Check interval in seconds (number)"
          disabled={busy}
        />
        <span className="muted">s</span>
      </label>
      {draft < 10 && <div className="muted small hint">Each check calls GitHub once per waiting PR — very short intervals with many promotions can hit GitHub's rate limit.</div>}
    </div>
  );
}
