import { app, BrowserWindow, Menu, Notification, Tray, nativeImage, shell, type MenuItemConstructorOptions } from 'electron';
import { fileURLToPath } from 'node:url';
import { Registry, inspect, repoExists } from '@git-helper/core';
import { startServer, type RunningServer } from '@git-helper/server';
import { disableLoginItem, enableLoginItem, isLoginItem, loginShellPath } from './login.js';

// Started from login/Finder/`open`, macOS gives a PATH without Homebrew (no `gh`); use the shell's.
process.env.PATH = loginShellPath();

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
      title: 'git helper',
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
    ...(server.isStale()
      ? [
          {
            label: 'Restart to apply update',
            click: () => {
              quitting = true;
              app.relaunch();
              app.exit(0);
            },
          } as MenuItemConstructorOptions,
          { type: 'separator' } as const,
        ]
      : []),
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
    promotionsItem(),
    { label: 'History', click: () => showWindow(dashboardUrl('history')) },
    { label: 'Refresh', click: () => void refreshMenu() },
    { type: 'separator' },
    ...(process.platform === 'darwin'
      ? [
          {
            label: 'Start at login',
            type: 'checkbox',
            checked: isLoginItem(),
            click: (item: Electron.MenuItem) => {
              if (item.checked) enableLoginItem({ electron: process.execPath, appPath: app.getAppPath(), path: process.env.PATH ?? '' });
              else disableLoginItem();
              void refreshMenu();
            },
          } as MenuItemConstructorOptions,
        ]
      : []),
    { label: 'Quit git helper', role: 'quit' },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function promotionsItem(): MenuItemConstructorOptions {
  const running = server.worker.store.list().filter((p) => p.status === 'running');
  const waiting = running.flatMap((p) => p.steps.filter((s) => s.status === 'open' && s.pr).map((s) => ({ p, s })));
  const label = running.length ? `Promotions — ${running.length} running` : 'Promotions';
  if (waiting.length === 0) return { label, click: () => showWindow(dashboardUrl('promotions')) };
  return {
    label,
    submenu: [
      { label: 'Open Promotions', click: () => showWindow(dashboardUrl('promotions')) },
      { type: 'separator' },
      ...waiting.map(({ p, s }): MenuItemConstructorOptions => ({
        label: `Merge ${p.repoName}: ${s.from} → ${s.to} (#${s.pr!.number})`,
        click: () => void shell.openExternal(s.pr!.url),
      })),
    ],
  };
}

/** While promotions are running, show the countdown to the next GitHub check next to the icon. */
function showCountdown(): void {
  setInterval(() => {
    if (!tray) return;
    const running = server.worker.store.list().some((p) => p.status === 'running');
    const st = server.worker.status();
    if (!running || !st.nextCheckAt) return tray.setTitle('');
    const left = Math.max(0, Math.ceil((new Date(st.nextCheckAt).getTime() - Date.now()) / 1000));
    tray.setTitle(st.checking || left === 0 ? ' …' : ` ${left}s`, { fontType: 'monospacedDigit' });
  }, 1000);
}

/** A desktop notification per PR that is waiting for the user; clicking it opens the PR. */
function watchPromotions(): void {
  server.worker.on((e) => {
    if (e.type === 'updated') return void refreshMenu();
    if (!Notification.isSupported() || !e.step.pr) return;
    const n = new Notification({
      title: `Merge ${e.promotion.repoName}: ${e.step.from} → ${e.step.to}`,
      body: `PR #${e.step.pr.number} is ready${e.step.autoMerge ? ' (auto-merge on)' : ''}. Click to open it on GitHub.`,
    });
    const url = e.step.pr.url;
    n.on('click', () => void shell.openExternal(url));
    n.show();
  });
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
    tray.setToolTip('git helper');
    watchPromotions();
    showCountdown();
    await refreshMenu();
    setInterval(() => void refreshMenu(), MENU_REFRESH_MS);
    app.on('activate', () => showWindow());
    showWindow();
  });
}
