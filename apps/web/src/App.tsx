import { useEffect, useRef } from 'react';
import { useDocumentTitle } from './components/ui.tsx';
import { CaseListPage } from './features/cases/CaseList.tsx';
import { CasePage } from './features/cases/CasePage.tsx';
import { NewCasePage } from './features/cases/NewCase.tsx';
import { SettingsPage } from './features/settings/SettingsPage.tsx';
import { RunPage } from './features/run/RunPage.tsx';
import { pl } from './i18n/pl.ts';
import { Link, parseRoute, routePath, useLocation, type Route } from './lib/router.tsx';

/** Analyst console shell: header, navigation, routed page, footer. All copy comes from `i18n/pl.ts`. */
export function App() {
  const location = useLocation();
  const route = parseRoute(location.pathname);
  const main = useRef<HTMLElement>(null);
  const pageKey = route.name === 'run' ? `run:${route.runId}` : location.pathname;

  // Move focus to the content when the page (not just the tab) changes, for keyboard and screen-reader users.
  const lastPage = useRef(pageKey);
  useEffect(() => {
    if (lastPage.current === pageKey) return;
    lastPage.current = pageKey;
    main.current?.focus({ preventScroll: true });
  }, [pageKey]);

  return (
    <>
      <a className="skip-link" href="#main">
        {pl.app.skipToContent}
      </a>
      <header className="topbar">
        <Link className="brand" to={routePath({ name: 'cases' })}>
          <span className="brand-name">{pl.app.name}</span>
          <span className="brand-full">{pl.app.fullName}</span>
        </Link>
        <nav aria-label={pl.app.mainNav}>
          <ul>
            <li>
              <Link to={routePath({ name: 'cases' })} aria-current={route.name === 'cases' ? 'page' : undefined}>
                {pl.app.navCases}
              </Link>
            </li>
            <li>
              <Link to={routePath({ name: 'newCase' })} aria-current={route.name === 'newCase' ? 'page' : undefined}>
                {pl.app.navNewCase}
              </Link>
            </li>
            <li>
              <Link to={routePath({ name: 'settings' })} aria-current={route.name === 'settings' ? 'page' : undefined}>
                {pl.app.navSettings}
              </Link>
            </li>
          </ul>
        </nav>
      </header>
      <main id="main" ref={main} tabIndex={-1}>
        <Page route={route} />
      </main>
      <footer className="footer">
        <p>{pl.app.footer}</p>
      </footer>
    </>
  );
}

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case 'cases':
      return <CaseListPage />;
    case 'newCase':
      return <NewCasePage />;
    case 'settings':
      return <SettingsPage />;
    case 'case':
      return <CasePage caseId={route.caseId} />;
    case 'run':
      return <RunPage caseId={route.caseId} runId={route.runId} tab={route.tab} />;
    case 'notFound':
      return <NotFound />;
  }
}

function NotFound() {
  useDocumentTitle(pl.app.notFound);
  return (
    <section className="page">
      <h1>{pl.app.notFound}</h1>
      <p>
        <Link to={routePath({ name: 'cases' })}>{pl.app.backToCases}</Link>
      </p>
    </section>
  );
}
