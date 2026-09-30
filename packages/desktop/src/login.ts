import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Kept free of Electron imports so it can also be driven from a plain Node script. */
export const LABEL = 'io.github.git-helper.tray';
export const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Apps started by macOS (login, Finder, `open`) get a minimal PATH without Homebrew, so `gh` would
 * be missing. Ask the user's login shell for the PATH they actually have.
 */
export function loginShellPath(fallback = process.env.PATH ?? ''): string {
  if (process.platform === 'win32') return fallback;
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(shell, ['-ilc', 'printf "__PATH__%s" "$PATH"'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const path = out.slice(out.lastIndexOf('__PATH__') + '__PATH__'.length).trim();
    return path || fallback;
  } catch {
    return fallback;
  }
}

export function isLoginItem(): boolean {
  return existsSync(PLIST);
}

/** Writes a LaunchAgent that starts the tray app at login and restarts it if it crashes (not when quit). */
export function enableLoginItem(opts: { electron: string; appPath: string; path: string; logFile?: string }): void {
  const log = opts.logFile ?? join(homedir(), 'Library', 'Logs', 'git-helper.log');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(opts.electron)}</string>
    <string>${xml(opts.appPath)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(opts.path)}</string></dict>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
  mkdirSync(dirname(PLIST), { recursive: true });
  writeFileSync(PLIST, plist);
}

export function disableLoginItem(): void {
  if (!existsSync(PLIST)) return;
  unlinkSync(PLIST);
  // If launchd has it loaded (from a login), unload it too; not loaded is fine.
  if (typeof process.getuid === 'function') execFile('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], () => {});
}
