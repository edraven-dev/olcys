/**
 * Minimal data hook: cached per key, previous data kept while reloading (no flicker), optional polling.
 * `key` identifies the request; pass `null` to skip loading.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';

const cache = new Map<string, { data: unknown; at: number }>();

export interface Resource<T> {
  data: T | undefined;
  /** Set when the last request failed — also while older `data` is still shown. */
  error: unknown;
  loading: boolean;
  /** Time (ms) of the last successful load of `data`. */
  updatedAt?: number;
  reload(): void;
}

interface State<T> {
  key: string | null;
  data: T | undefined;
  error: unknown;
  loading: boolean;
  updatedAt?: number;
}

function cached<T>(key: string | null): { data: T | undefined; updatedAt?: number } {
  const hit = key ? cache.get(key) : undefined;
  return hit ? { data: hit.data as T, updatedAt: hit.at } : { data: undefined };
}

export function useResource<T>(key: string | null, load: () => Promise<T>, pollMs?: number): Resource<T> {
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  const [state, setState] = useState<State<T>>(() => ({
    key,
    ...cached<T>(key),
    error: undefined,
    loading: key !== null,
  }));
  const [tick, setTick] = useState(0);
  const request = key === null ? null : `${key}@${tick}`;

  useEffect(() => {
    if (request === null || key === null) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      try {
        const data = await loadRef.current();
        if (cancelled) return;
        const at = Date.now();
        cache.set(key, { data, at });
        setState({ key, data, error: undefined, loading: false, updatedAt: at });
      } catch (error) {
        if (cancelled) return;
        // Older data stays visible, but the error is kept so the view can say the data is stale.
        setState((s) =>
          s.key === key ? { ...s, error, loading: false } : { key, ...cached<T>(key), error, loading: false },
        );
      }
      if (pollMs && !cancelled) timer = setTimeout(() => void run(), pollMs);
    };
    void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [request, key, pollMs]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  if (state.key === key) return { ...state, reload };
  return { ...cached<T>(key), error: undefined, loading: key !== null, reload };
}

/** JSON document; `version` forces a fresh request when it changes (e.g. the run finished). */
export function useJson<T>(path: string | null, options: { version?: string; pollMs?: number } = {}): Resource<T> {
  const key = path === null ? null : `${path}#${options.version ?? ''}`;
  return useResource<T>(key, () => api.get<T>(path ?? ''), options.pollMs);
}

export function useList<T>(path: string | null, options: { version?: string; pollMs?: number } = {}): Resource<T[]> {
  const key = path === null ? null : `${path}#list#${options.version ?? ''}`;
  return useResource<T[]>(key, () => api.list<T>(path ?? ''), options.pollMs);
}

/** List from a route that may not exist yet: `null` data means "not provided by this API version". */
export function useOptionalList<T>(path: string | null, options: { version?: string } = {}): Resource<T[] | null> {
  const key = path === null ? null : `${path}#optional#${options.version ?? ''}`;
  return useResource<T[] | null>(key, () => api.listOptional<T>(path ?? ''));
}
