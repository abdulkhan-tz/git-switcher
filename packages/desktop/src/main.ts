import { app, BrowserWindow, Menu, Tray, nativeImage, shell, type MenuItemConstructorOptions } from 'electron';
import { fileURLToPath } from 'node:url';
import { Registry, inspect, repoExists } from '@gsw/core';
import { startServer, type RunningServer } from '@gsw/server';

// packages/desktop/dist → packages/web/dist and packages/desktop/assets
const WEB_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url));
const ICON = fileURLToPath(new URL('../assets/trayTemplate.png', import.meta.url));
const SMOKE = process.argv.includes('--smoke');
const MENU_REFRESH_MS = 30_000;

let server: RunningServer;
let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let quitting = false;
const registry = new Registry();

/** Dashboard URL for a page, optionally preselecting a group. The token rides in the query. */
function dashboardUrl(page = 'repos', group?: string): string {
  const hash = `#/${page}${group ? `?group=${encodeURIComponent(group)}` : ''}`;
  return `${server.url}${hash}`;
}

function showWindow(url = dashboardUrl()): void {
  if (!win) {
    win = new BrowserWindow({
      width: 1100,
      height: 760,
      minWidth: 420,
      minHeight: 400,
      title: 'git-switcher',
      show: !SMOKE,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    // The window only ever shows our own dashboard; anything else goes to the default browser.
    const origin = new URL(server.url).origin;
    win.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (new URL(url).origin !== origin) e.preventDefault();
    });
    win.on('close', (e) => {
      // Closing the window keeps the app alive in the tray.
      if (!quitting) {
        e.preventDefault();
        win?.hide();
        app.dock?.hide();
      }
    });
    win.on('focus', () => void refreshMenu());
  }
  void win.loadURL(url);
  if (!SMOKE) {
    app.dock?.show();
    win.show();
    win.focus();
  }
}

async function repoItems(): Promise<MenuItemConstructorOptions[]> {
  const repos = registry.list();
  if (repos.length === 0) return [{ label: 'No repos registered', enabled: false }];
  return Promise.all(
    repos.map(async (r): Promise<MenuItemConstructorOptions> => {
      if (!repoExists(r)) return { label: `${r.name} — missing`, enabled: false };
      try {
        const s = await inspect(r.path);
        const dirty = s.uncommitted + s.untracked > 0 ? '  ●' : '';
        return { label: `${r.name} — ${s.branch ?? '(detached)'}${dirty}`, click: () => showWindow() };
      } catch {
        return { label: `${r.name} — unreadable`, enabled: false };
      }
    }),
  );
}

async function refreshMenu(): Promise<void> {
  if (!tray) return;
  const groups = registry.groups();
  const template: MenuItemConstructorOptions[] = [
    { label: 'Open Dashboard', click: () => showWindow() },
    { type: 'separator' },
    ...(await repoItems()),
    ...(groups.length
      ? [
          { type: 'separator' } as const,
          ...groups.map((g): MenuItemConstructorOptions => ({ label: `Switch ${g.name}…`, click: () => showWindow(dashboardUrl('repos', g.name)) })),
        ]
      : []),
    { type: 'separator' },
    { label: 'History', click: () => showWindow(dashboardUrl('history')) },
    { label: 'Refresh', click: () => void refreshMenu() },
    { type: 'separator' },
    { label: 'Quit git-switcher', role: 'quit' },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

async function smokeTest(): Promise<void> {
  // Load the dashboard hidden and confirm it rendered and reached the API, then exit.
  showWindow();
  await new Promise<void>((resolve) => win!.webContents.once('did-finish-load', () => resolve()));
  const ok = await win!.webContents.executeJavaScript(
    `new Promise((r) => { const t = Date.now(); (function poll() {
       const text = document.body.innerText;
       if (text.includes('Repositories') && !text.includes('Loading')) return r(true);
       if (Date.now() - t > 8000) return r(false);
       setTimeout(poll, 100); })(); })`,
  );
  console.log(ok ? 'SMOKE OK' : 'SMOKE FAIL');
  quitting = true;
  app.exit(ok ? 0 : 1);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.on('before-quit', () => {
    quitting = true;
  });
  // Tray app: closing every window must not quit.
  app.on('window-all-closed', () => {});

  app.whenReady().then(async () => {
    server = await startServer({ webDir: WEB_DIR });
    app.on('will-quit', () => void server.close());
    if (SMOKE) return smokeTest();

    const icon = nativeImage.createFromPath(ICON);
    icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip('git-switcher');
    await refreshMenu();
    setInterval(() => void refreshMenu(), MENU_REFRESH_MS);
    app.on('activate', () => showWindow());
    showWindow();
  });
}
