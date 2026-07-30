// Mirrors the real layout block for block, so the page does not reflow when the
// data lands. Never an empty axis frame for the chart — an axis with no bars reads
// as "zero everywhere", which is the one thing this page must never imply.

import { PageHeaderSkeleton, Skeleton } from "@/components/skeleton";

export default function Loading() {
  return (
    <div className="p-container-margin space-y-6">
      <PageHeaderSkeleton />
      <Skeleton className="h-9 w-64 rounded-control" />
      <Skeleton className="h-10 w-56 rounded-control" />
      <div className="card p-6 space-y-3">
        <Skeleton className="h-5 w-40" />
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-4 w-full" />
        ))}
        <Skeleton className="h-20 w-full rounded-card" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-gutter">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24 w-full rounded-card" />
        ))}
      </div>
      <Skeleton className="h-64 w-full rounded-card" />
    </div>
  );
}
