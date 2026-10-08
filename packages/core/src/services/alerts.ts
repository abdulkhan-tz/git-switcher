import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import type { ServiceAlert } from './types.js';

/** Log lines that mean a database migration did not go through. */
const LIQUIBASE = [
  /Failed to run Liquibase migration/i,
  /Migration failed for/i,
  /liquibase\.exception\.\w+/i,
  /Checksum validation failed|Validation Failed/i,
  /Migration failed for change set/i,
  /Could not (?:acquire|release) change log lock/i,
];

const MAX_SCAN = 4 * 1024 * 1024;
const cache = new Map<string, { key: string; alerts: ServiceAlert[] }>();

/**
 * Looks for trouble in what a service logged since `fromOffset` (the log size when it was started).
 * Cheap to call on every status poll: the result is reused until the file changes.
 */
export function scanLog(file: string, fromOffset = 0): ServiceAlert[] {
  if (!existsSync(file)) return [];
  const size = statSync(file).size;
  const key = `${size}:${fromOffset}`;
  const hit = cache.get(file);
  if (hit?.key === key) return hit.alerts;
  // a cleared log (size below the offset) starts over from the top
  const start = Math.max(size < fromOffset ? 0 : fromOffset, size - MAX_SCAN);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  const alerts: ServiceAlert[] = [];
  const lines = buf.toString('utf8').split('\n');
  for (const line of lines) {
    if (!LIQUIBASE.some((re) => re.test(line))) continue;
    // "… ERROR c.t.Helper [doc= tid=] - Failed to run …" → keep the message after " - "
    const message = (line.includes(' - ') ? line.slice(line.indexOf(' - ') + 3) : line).replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!alerts.some((a) => a.message === message)) alerts.push({ kind: 'liquibase', message });
    if (alerts.length >= 5) break;
  }
  cache.set(file, { key, alerts });
  return alerts;
}
