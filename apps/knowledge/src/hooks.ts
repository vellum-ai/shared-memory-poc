import { useCallback, useEffect, useRef, useState } from "react";

import { errorMessage } from "./api";

export interface Resource<T> {
  /** Last successful payload. Kept across a failed refetch so data goes stale
   *  rather than disappearing. */
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

export interface ResourceOptions {
  /** Refetch interval in milliseconds. 0 disables polling. */
  pollMs?: number;
  /** When false the resource stays idle and holds no data. */
  enabled?: boolean;
}

interface ResourceState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/**
 * Loads a value, re-loads when `deps` change, and optionally polls.
 *
 * Polling only fires while the document is visible, and a return to visibility
 * triggers an immediate refetch so a backgrounded tab is never read as fresh.
 */
export function useResource<T>(
  load: () => Promise<T>,
  deps: readonly unknown[],
  options: ResourceOptions = {},
): Resource<T> {
  const { pollMs = 0, enabled = true } = options;

  const [state, setState] = useState<ResourceState<T>>({
    data: null,
    error: null,
    loading: enabled,
  });

  // Held in a ref so a new closure each render does not restart the poll.
  const loadRef = useRef(load);
  loadRef.current = load;

  // Guards against a slow response from a superseded request landing last.
  const generation = useRef(0);

  const run = useCallback(
    () => {
      if (!enabled) return;
      const current = ++generation.current;
      setState((previous) => ({ ...previous, loading: true }));
      loadRef.current().then(
        (data) => {
          if (current !== generation.current) return;
          setState({ data, error: null, loading: false });
        },
        (cause: unknown) => {
          if (current !== generation.current) return;
          setState((previous) => ({
            data: previous.data,
            error: errorMessage(cause),
            loading: false,
          }));
        },
      );
    },
    // The caller owns the identity of `load` through `deps`.
    [...deps, enabled],
  );

  useEffect(() => {
    if (!enabled) {
      generation.current += 1;
      setState({ data: null, error: null, loading: false });
      return;
    }
    run();
  }, [run, enabled]);

  useEffect(() => {
    if (!enabled || pollMs <= 0) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") run();
    }, pollMs);
    const onVisibility = () => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [run, pollMs, enabled]);

  return { data: state.data, error: state.error, loading: state.loading, reload: run };
}

/** Returns `value` after it has held still for `delayMs`. */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}

/**
 * Bumps a counter whenever the OS colour scheme flips, so chart instances that
 * read their colours from CSS custom properties can be rebuilt.
 */
export function useColorSchemeTick(): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setTick((value) => value + 1);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return tick;
}
