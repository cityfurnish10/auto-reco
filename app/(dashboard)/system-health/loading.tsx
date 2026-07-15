// Route-level loading UI for System Health: header → connector status cards →
// ingestion-log table → activity card.
import { PageHeaderSkeleton, CardGridSkeleton, TableSkeleton, Skeleton } from "@/components/skeleton";

export default function SystemHealthLoading() {
  return (
    <div className="p-container-margin space-y-6">
      <PageHeaderSkeleton />
      <CardGridSkeleton count={4} className="grid-cols-1 md:grid-cols-2 lg:grid-cols-4" lines={2} />
      <TableSkeleton rows={6} cols={5} />
      <div className="card p-6 space-y-4">
        <Skeleton className="h-5 w-48" />
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-3 w-full" />
        ))}
      </div>
    </div>
  );
}
