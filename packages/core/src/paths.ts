import { existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let migrated = false;

/**
 * `$GIT_HELPER_HOME`, else `$XDG_CONFIG_HOME/git-helper`, else `~/.config/git-helper`.
 * The first call moves a config left by the tool's old name (`git-switcher`) into place.
 */
export function configDir(): string {
  if (process.env.GIT_HELPER_HOME) return process.env.GIT_HELPER_HOME;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const dir = join(base, 'git-helper');
  if (!migrated) {
    migrated = true;
    const legacy = join(base, 'git-switcher');
    if (!existsSync(dir) && existsSync(legacy)) {
      try {
        renameSync(legacy, dir);
      } catch {
        return legacy;
      }
    }
  }
  return dir;
}
