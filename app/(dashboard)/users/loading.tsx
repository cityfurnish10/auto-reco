// Route-level loading UI for User Management: header (stat cards + search) →
// users table.
import { TableSkeleton, Skeleton } from "@/components/skeleton";

export default function UsersLoading() {
  return (
    <div className="p-container-margin">
      <div className="flex justify-between items-end mb-6">
        <div>
          <Skeleton className="h-4 w-56 mb-3" />
          <div className="flex gap-4">
            <Skeleton className="h-[62px] w-40 rounded-xl" />
            <Skeleton className="h-[62px] w-40 rounded-xl" />
            <Skeleton className="h-9 w-[280px] self-center rounded-lg" />
          </div>
        </div>
        <Skeleton className="h-9 w-32 rounded-lg" />
      </div>

      <TableSkeleton rows={8} cols={6} title={false} />
    </div>
  );
}
