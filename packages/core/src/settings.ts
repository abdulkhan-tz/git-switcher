import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configDir } from './paths.js';

export interface Settings {
  /** How often the promotion worker checks GitHub, 1–60 seconds. */
  promotionIntervalSec: number;
  /** Off: the worker makes no GitHub calls; running promotions just wait. */
  promotionChecksEnabled: boolean;
}

export const DEFAULT_SETTINGS: Settings = { promotionIntervalSec: 60, promotionChecksEnabled: true };
export const MIN_INTERVAL_SEC = 1;
export const MAX_INTERVAL_SEC = 60;

export class SettingsError extends Error {}

export function validInterval(sec: unknown): number {
  const n = Number(sec);
  if (!Number.isInteger(n) || n < MIN_INTERVAL_SEC || n > MAX_INTERVAL_SEC) {
    throw new SettingsError(`the check interval must be a whole number of seconds from ${MIN_INTERVAL_SEC} to ${MAX_INTERVAL_SEC}`);
  }
  return n;
}

/** User settings shared by every git-tidy process; re-read on use so changes apply everywhere. */
export class SettingsStore {
  constructor(readonly file: string = join(configDir(), 'settings.json')) {}

  load(): Settings {
    if (!existsSync(this.file)) return { ...DEFAULT_SETTINGS };
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Settings>;
      let promotionIntervalSec = DEFAULT_SETTINGS.promotionIntervalSec;
      try {
        promotionIntervalSec = validInterval(raw.promotionIntervalSec);
      } catch {
        /* keep the default for a missing or out-of-range value */
      }
      const promotionChecksEnabled = typeof raw.promotionChecksEnabled === 'boolean' ? raw.promotionChecksEnabled : DEFAULT_SETTINGS.promotionChecksEnabled;
      return { promotionIntervalSec, promotionChecksEnabled };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  update(patch: Partial<Settings>): Settings {
    const next = { ...this.load(), ...patch };
    next.promotionIntervalSec = validInterval(next.promotionIntervalSec);
    if (typeof next.promotionChecksEnabled !== 'boolean') throw new SettingsError('promotionChecksEnabled must be true or false');
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    renameSync(tmp, this.file);
    return next;
  }
}
