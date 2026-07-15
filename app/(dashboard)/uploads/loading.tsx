// Route-level loading UI for Guard Register Uploads: header → per-city status
// chips → upload zone + insights → recent-uploads table.
import { TableSkeleton, Skeleton } from "@/components/skeleton";

export default function UploadsLoading() {
  return (
    <div className="p-container-margin space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>

      {/* Per-city status chips */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="card p-4 space-y-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>

      {/* Upload zone + insights side panel */}
      <div className="grid grid-cols-12 gap-gutter">
        <div className="col-span-12 lg:col-span-8">
          <div className="card p-6 space-y-4">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-48 w-full rounded-xl" />
            <div className="flex gap-3">
              <Skeleton className="h-9 w-32 rounded-lg" />
              <Skeleton className="h-9 w-32 rounded-lg" />
            </div>
          </div>
        </div>
        <div className="col-span-12 lg:col-span-4">
          <div className="card p-6 h-full space-y-3">
            <Skeleton className="h-5 w-32" />
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-3 w-full" />
            ))}
          </div>
        </div>
      </div>

      <TableSkeleton rows={5} cols={6} />
    </div>
  );
}
