import { homedir } from 'node:os';
import { join } from 'node:path';

/** `$GIT_SWITCHER_HOME`, else `$XDG_CONFIG_HOME/git-switcher`, else `~/.config/git-switcher`. */
export function configDir(): string {
  if (process.env.GIT_SWITCHER_HOME) return process.env.GIT_SWITCHER_HOME;
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'git-switcher');
}
