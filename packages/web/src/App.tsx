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

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>⎇</span> git-switcher
        </div>
        <nav>
          {PAGES.map((p) => (
            <a key={p.id} href={`#/${p.id}`} className={p.id === pageId ? 'active' : ''}>
              {p.label}
            </a>
          ))}
        </nav>
      </header>
      <main>
        {api.hasToken() ? (
          <Page />
        ) : (
          <div className="notice error">No access token. Open the dashboard with <code>gsw ui</code>, which puts the token in the URL.</div>
        )}
      </main>
    </div>
  );
}
