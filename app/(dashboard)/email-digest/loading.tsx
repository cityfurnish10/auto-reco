// Route-level loading UI for the Email Digest preview: header → centered
// email-preview card with a 3-up stat grid.
import { Skeleton } from "@/components/skeleton";

export default function EmailDigestLoading() {
  return (
    <div className="p-container-margin">
      <div className="flex justify-between items-end mb-6">
        <div className="space-y-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-9 w-36 rounded-lg" />
      </div>

      <div className="max-w-2xl mx-auto card p-8 space-y-6">
        <div className="flex flex-col items-center gap-3">
          <Skeleton className="h-10 w-40" />
          <Skeleton className="h-4 w-56" />
        </div>
        <Skeleton className="h-5 w-64" />
        <div className="grid grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="card p-4 space-y-2">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-6 w-12" />
            </div>
          ))}
        </div>
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-3 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
