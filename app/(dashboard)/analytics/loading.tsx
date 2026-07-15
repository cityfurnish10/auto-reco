// Route-level loading UI for Analytics: header + range toggle → KPI row →
// accuracy chart → two-column breakdown cards.
import { KpiTilesSkeleton, Skeleton } from "@/components/skeleton";

export default function AnalyticsLoading() {
  return (
    <div className="p-container-margin space-y-6">
      {/* Header + range toggle */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-6 w-52" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-9 w-40 rounded-control" />
      </div>

      <KpiTilesSkeleton count={4} />

      {/* Accuracy trend chart */}
      <div className="card p-6 space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-5 w-64" />
          <div className="flex gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-20 rounded-full" />
            ))}
          </div>
        </div>
        <Skeleton className="h-56 w-full rounded-lg" />
      </div>

      {/* Two-column breakdowns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {Array.from({ length: 2 }).map((_, card) => (
          <div key={card} className="card p-6 space-y-4">
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-4 w-72 max-w-full" />
            <div className="space-y-3 pt-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="space-y-1.5">
                  <div className="flex justify-between">
                    <Skeleton className="h-3 w-32" />
                    <Skeleton className="h-3 w-8" />
                  </div>
                  <Skeleton className="h-2 w-full rounded-full" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
