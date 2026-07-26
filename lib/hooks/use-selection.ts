"use client";

// Row selection for a server-paginated table.
//
// Selection is kept as an id Set that SURVIVES paging and refetching, because
// the whole point is working through a few hundred rows: selecting 20 on page 1
// and 15 on page 2 then acting on all 35 is the workflow. That means the set can
// legitimately contain ids that aren't currently rendered, so `pruneTo` exists
// for the one case where they must be dropped — a filter change, after which
// those rows are no longer part of what the user is looking at.

import { useCallback, useMemo, useState } from "react";

export function useSelection(visibleIds: string[]) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const clear = useCallback(() => setSelected(new Set()), []);

  // Shift-click range select, the thing that makes a 25-row page bearable.
  const selectRange = useCallback((ids: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const visibleSelectedCount = useMemo(
    () => visibleIds.reduce((n, id) => n + (selected.has(id) ? 1 : 0), 0),
    [visibleIds, selected]
  );

  const allVisibleSelected = visibleIds.length > 0 && visibleSelectedCount === visibleIds.length;
  // Drives the header checkbox's indeterminate state — "some of this page".
  const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected;

  const toggleAllVisible = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      const everyOn = visibleIds.length > 0 && visibleIds.every((id) => next.has(id));
      for (const id of visibleIds) {
        if (everyOn) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }, [visibleIds]);

  // Drop anything no longer in `keep`. Call on a filter change, not on paging.
  const pruneTo = useCallback((keep: Set<string>) => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => keep.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, []);

  return {
    selected,
    ids: useMemo(() => [...selected], [selected]),
    count: selected.size,
    has: useCallback((id: string) => selected.has(id), [selected]),
    toggle,
    toggleAllVisible,
    selectRange,
    clear,
    pruneTo,
    allVisibleSelected,
    someVisibleSelected,
    visibleSelectedCount,
  };
}

export type Selection = ReturnType<typeof useSelection>;
