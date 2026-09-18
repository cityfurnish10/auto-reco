// The flags a variance carries (lib/variances/flags.ts), as small labels next
// to its name. Renders nothing for a row without any — or one read before the
// API attached them.

import { FLAG_HINT, type VarianceFlag } from "@/lib/variances/flags";

export function VarianceFlags({ flags, className = "" }: { flags?: string[] | null; className?: string }) {
  if (!flags?.length) return null;
  return (
    <span className={`flex flex-wrap gap-1 mt-1 ${className}`}>
      {flags.map((f) => (
        <span key={f} className="badge badge-medium uppercase" title={FLAG_HINT[f as VarianceFlag] ?? f}>
          {f}
        </span>
      ))}
    </span>
  );
}
