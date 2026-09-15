// A variance's name, as a person should read it.
//
// Two lines, because the two halves answer different questions and one line
// could only ever answer one of them:
//
//   "Register Gap"                                      what kind of problem
//   "Seen by Manual Sheet + Odoo · Missing from Guard Check"   who has the record
//
// The short name is the one the digest email has always used; showing the same
// word in both places is the whole reason it is here rather than the engine's
// own name, which the table used to print and the email never did.
//
// Neither line is the stored value. `variance_name` stays exactly as written
// (see lib/ui/variance-phrases.ts) so filters, history and the six obsolete
// spellings all keep working.

import { labelFor, type LabelContext } from "@/lib/ui/variance-labels";
import { variancePhrase } from "@/lib/ui/variance-phrases";

export function VarianceName({ name, ctx, className }: {
  name: string;
  /** Direction, job type, bucket and note — some labels refine on them. */
  ctx?: LabelContext;
  className?: string;
}) {
  const label = labelFor(name, ctx ?? {});
  const phrase = variancePhrase(name);
  return (
    <span className={className}>
      {/* The stored name on hover: the one thing a support conversation or a
          database query still needs, and the only place it now appears. */}
      <span className="text-text-primary font-medium" title={name}>
        {label.display}
      </span>
      {phrase && (
        <span className="block text-xs text-text-muted mt-0.5">{phrase}</span>
      )}
    </span>
  );
}
