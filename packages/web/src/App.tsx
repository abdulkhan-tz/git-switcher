import { useEffect, useState } from 'react';
import { api } from './api';
import { PAGES } from './pages';

function currentPage(): string {
  const id = location.hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  return PAGES.some((p) => p.id === id) ? id : PAGES[0]!.id;
}

export function App() {
  const [pageId, setPageId] = useState(currentPage);
  useEffect(() => {
    const onHash = () => setPageId(currentPage());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  const Page = PAGES.find((p) => p.id === pageId)!.component;
  // A long-running dashboard keeps the engine it started with; say so once it has been rebuilt.
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (!api.hasToken()) return;
    const check = () => void api.version().then((v) => setStale(v.stale), () => {});
    check();
    const t = setInterval(check, 60_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>⎇</span> tidy
        </div>
        <nav aria-label="Sections">
          {(['Git', 'Services'] as const).map((section) => (
            <div key={section} className="nav-section" role="group" aria-label={section}>
              <span className="nav-label">{section}</span>
              {PAGES.filter((p) => p.section === section).map((p) => (
                <a key={p.id} href={`#/${p.id}`} className={p.id === pageId ? 'active' : ''}>
                  {p.label}
                </a>
              ))}
            </div>
          ))}
        </nav>
      </header>
      <main>
        {stale && (
          <div className="notice warn-notice" role="status">
            tidy was updated since this window started and is still running the old version. Restart it (tray: <strong>Restart to apply update</strong>, or rerun <code>git-tidy ui</code>).
          </div>
        )}
        {api.hasToken() ? (
          <Page />
        ) : (
          <div className="notice error">No access token. Open the dashboard with <code>git-tidy ui</code>, which puts the token in the URL.</div>
        )}
      </main>
    </div>
  );
}
