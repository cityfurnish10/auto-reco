// Route-level loading UI for the Pending List: header → table.
import { PageHeaderSkeleton, TableSkeleton } from "@/components/skeleton";

export default function PendingListLoading() {
  return (
    <div className="p-container-margin space-y-6">
      <PageHeaderSkeleton />
      <TableSkeleton rows={8} cols={7} />
    </div>
  );
}
