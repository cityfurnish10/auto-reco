// Route-level loading UI for the Leaderboard: header → KPI row → ranked table.
import { PageHeaderSkeleton, KpiTilesSkeleton, TableSkeleton } from "@/components/skeleton";

export default function LeaderboardLoading() {
  return (
    <div className="p-container-margin space-y-6">
      <PageHeaderSkeleton />
      <KpiTilesSkeleton count={4} />
      <TableSkeleton rows={5} cols={6} />
    </div>
  );
}
