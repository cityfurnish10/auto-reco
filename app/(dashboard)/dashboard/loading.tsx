// Route-level loading UI for the main dashboard: KPI row → city cards → the
// variances table. Mirrors admin-dashboard.tsx so the skeleton → data swap
// doesn't jump.
import {
  PageHeaderSkeleton,
  KpiTilesSkeleton,
  CardGridSkeleton,
  TableSkeleton,
  Skeleton,
} from "@/components/skeleton";

export default function DashboardLoading() {
  return (
    <div className="p-container-margin space-y-6">
      <PageHeaderSkeleton />
      <KpiTilesSkeleton count={4} />

      <div className="space-y-4">
        <Skeleton className="h-5 w-48" />
        <CardGridSkeleton count={5} className="grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5" />
      </div>

      <TableSkeleton rows={8} cols={7} />
    </div>
  );
}
