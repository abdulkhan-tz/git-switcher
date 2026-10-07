import { existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let migrated = false;

/**
 * `$TIDY_HOME`, else `$XDG_CONFIG_HOME/tidy`, else `~/.config/tidy`.
 * The first call moves a config left by an earlier name (`git-helper`, `git-switcher`) into place.
 */
export function configDir(): string {
  if (process.env.TIDY_HOME) return process.env.TIDY_HOME;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const dir = join(base, 'tidy');
  if (!migrated) {
    migrated = true;
    // newest old name first
    const legacy = ['git-helper', 'git-switcher'].map((n) => join(base, n)).find((p) => existsSync(p));
    if (!existsSync(dir) && legacy) {
      try {
        renameSync(legacy, dir);
      } catch {
        return legacy;
      }
    }
  }
  return dir;
}
