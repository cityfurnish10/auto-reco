// Reusable skeleton primitives for the route-level loading.tsx files. These
// are server components (no client JS) — the shimmer is pure CSS (.skeleton in
// globals.css). Each composed piece mirrors a real layout block (KPI row,
// table, card grid) so the swap from skeleton → real content doesn't shift the
// page. Shape/size is driven by utility classes, same tokens as the real UI.

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

// Page title + optional one-line subtitle — the header every page opens with.
export function PageHeaderSkeleton({ subtitle = true }: { subtitle?: boolean }) {
  return (
    <div className="space-y-2">
      <Skeleton className="h-6 w-56" />
      {subtitle && <Skeleton className="h-4 w-80 max-w-full" />}
    </div>
  );
}

// A row of KPI tiles (the `.kpi-tile` pattern): label + big value.
export function KpiTilesSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="kpi-tile">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-7 w-16 mt-3" />
        </div>
      ))}
    </div>
  );
}

// A data table (`.table-clean` in a `.card`): title bar, header row, body rows.
export function TableSkeleton({
  rows = 8,
  cols = 6,
  title = true,
}: {
  rows?: number;
  cols?: number;
  title?: boolean;
}) {
  return (
    <div className="card overflow-hidden">
      {title && (
        <div className="px-4 py-3 border-b border-border">
          <Skeleton className="h-4 w-44" />
        </div>
      )}
      <div className="px-4 py-3 flex gap-4 bg-surface-elevated border-b border-border">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={r}
          className="px-4 py-3.5 flex gap-4 items-center border-b border-border last:border-b-0"
        >
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className={`h-4 flex-1 ${c === 0 ? "max-w-[150px]" : ""}`} />
          ))}
        </div>
      ))}
    </div>
  );
}

// A grid of simple content cards (city cards, connector cards).
export function CardGridSkeleton({
  count = 5,
  className = "grid-cols-1 md:grid-cols-2 lg:grid-cols-5",
  lines = 3,
}: {
  count?: number;
  className?: string;
  lines?: number;
}) {
  return (
    <div className={`grid gap-4 ${className}`}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card p-5 space-y-3">
          <Skeleton className="h-4 w-20" />
          {Array.from({ length: lines }).map((_, l) => (
            <Skeleton key={l} className={`h-3 ${l === lines - 1 ? "w-2/3" : "w-full"}`} />
          ))}
        </div>
      ))}
    </div>
  );
}
