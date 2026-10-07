import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '@tidy/server';
import type { Out } from './io.js';

/** The built dashboard, relative to this file: packages/cli/dist → packages/web/dist. */
export const WEB_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url));

export function openInBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(cmd, [url], () => {});
}

/** Runs the dashboard until Ctrl-C. */
export async function startUi(opts: { port?: number; open: boolean }, out: Out): Promise<number> {
  const running = await startServer({ port: opts.port, webDir: WEB_DIR });
  out.line(`Dashboard: ${out.bold(running.url)}`);
  out.line(out.dim('Ctrl-C to stop.'));
  if (opts.open) openInBrowser(running.url);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await running.close();
  return 0;
}
