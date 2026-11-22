/**
 * Tiny History-API router. URL path segments are Polish (`/sprawy/:caseId/przebiegi/:runId/powiazania`); route and
 * tab identifiers in code stay English.
 */
import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from 'react';

export const RUN_TABS = ['overview', 'links', 'graph', 'rejected', 'activity', 'sources', 'changes', 'report'] as const;
export type RunTab = (typeof RUN_TABS)[number];

const TAB_SEGMENTS: Record<RunTab, string> = {
  overview: 'przeglad',
  links: 'powiazania',
  graph: 'graf',
  rejected: 'odrzucone',
  activity: 'aktywnosc',
  sources: 'zrodla',
  changes: 'zmiany',
  report: 'raport',
};

export type Route =
  | { name: 'cases' }
  | { name: 'newCase' }
  | { name: 'case'; caseId: string }
  | { name: 'run'; caseId: string; runId: string; tab: RunTab }
  | { name: 'notFound' };

const segment = (value: string) => encodeURIComponent(value);

export function routePath(route: Route): string {
  switch (route.name) {
    case 'cases':
      return '/';
    case 'newCase':
      return '/sprawy/nowa';
    case 'case':
      return `/sprawy/${segment(route.caseId)}`;
    case 'run':
      return `/sprawy/${segment(route.caseId)}/przebiegi/${segment(route.runId)}/${TAB_SEGMENTS[route.tab]}`;
    case 'notFound':
      return '/';
  }
}

export function parseRoute(pathname: string): Route {
  const parts = pathname
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  if (parts.length === 0) return { name: 'cases' };
  if (parts[0] !== 'sprawy') return { name: 'notFound' };
  if (parts.length === 1) return { name: 'cases' };
  if (parts.length === 2) return parts[1] === 'nowa' ? { name: 'newCase' } : { name: 'case', caseId: parts[1] ?? '' };
  if (parts[2] === 'przebiegi' && parts.length >= 4) {
    const tabSegment = parts[4] ?? TAB_SEGMENTS.overview;
    const tab = RUN_TABS.find((candidate) => TAB_SEGMENTS[candidate] === tabSegment);
    if (tab && parts.length <= 5) return { name: 'run', caseId: parts[1] ?? '', runId: parts[3] ?? '', tab };
  }
  return { name: 'notFound' };
}

const NAVIGATE_EVENT = 'olcys:navigate';

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (options.replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

export interface Location {
  pathname: string;
  search: string;
  hash: string;
}

function currentLocation(): Location {
  return { pathname: window.location.pathname, search: window.location.search, hash: window.location.hash };
}

export function useLocation(): Location {
  const [location, setLocation] = useState(currentLocation);
  useEffect(() => {
    const update = () => setLocation(currentLocation());
    window.addEventListener('popstate', update);
    window.addEventListener(NAVIGATE_EVENT, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(NAVIGATE_EVENT, update);
    };
  }, []);
  return location;
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { to: string };

/** In-app link: a real `<a href>` (works with keyboard, middle click, copy link) without a full page load. */
export function Link({ to, onClick, children, ...rest }: LinkProps) {
  const handle = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    const [path, hash] = to.split('#');
    navigate(to);
    if (hash) document.getElementById(hash)?.scrollIntoView();
    else if (path) window.scrollTo(0, 0);
  };
  return (
    <a href={to} onClick={handle} {...rest}>
      {children}
    </a>
  );
}
