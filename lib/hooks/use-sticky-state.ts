"use client";

// State that survives leaving a page and coming back.
//
// The dashboard's filters are plain useState, so navigating to Uploads and back
// unmounts the component and resets everything — most annoyingly the business
// date, which the user may have deliberately set to an earlier day.
//
// WHY A MODULE VARIABLE AND NOT sessionStorage: storage can only be read inside
// an effect (it doesn't exist during SSR), which means the first render uses the
// default, fires a fetch for the latest run, and only then corrects. The KPI
// tiles visibly flip from one day's numbers to another. A module-scoped Map is
// readable synchronously in a lazy useState initializer, so the page paints the
// right day immediately, with no second fetch.
//
// The trade-off is deliberate: this resets on a hard reload or a new tab, which
// is the right default — a fresh visit should show the latest run, not a date
// somebody picked yesterday and forgot about. In-app navigation is what people
// actually do between checking a date and coming back to it.
//
// SSR-safe: the server never writes to the map. The setter only runs from event
// handlers, which are client-only, so there is no cross-request leakage between
// users and no hydration mismatch (both server and first client render see the
// same empty map on a fresh load).

import { useCallback, useState } from "react";

const store = new Map<string, unknown>();

export function useStickyState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() =>
    store.has(key) ? (store.get(key) as T) : initial
  );

  const set = useCallback(
    (next: T) => {
      store.set(key, next);
      setValue(next);
    },
    [key]
  );

  return [value, set];
}

// Escape hatch for tests and for a deliberate "start clean" action.
export function clearStickyState(key?: string): void {
  if (key) store.delete(key);
  else store.clear();
}
