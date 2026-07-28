// Section 8 — Cross-Direction Check (Direction Conflict). A barcode that
// appears in both the IN and OUT union with the SAME normalized SO number is
// normally a same-day replacement, not a stock gap. Suppress via the
// Replace-as-Repair and Direction-Conflict Failed-Delivery fixes (Section 7);
// otherwise emit a Direction Conflict (High, direction CROSS).

import { isNewRental, isRepairEquivalent, normalizeSO } from "./util";
import { hasDone, orFlags, presenceOf } from "./views";
import { VARIANCE } from "./variance-names";
import type { BarcodeView, VarianceRowOut } from "./types";

export function detectDirectionConflicts(
  inViews: Map<string, BarcodeView>,
  outViews: Map<string, BarcodeView>,
  suppressed: Set<string>
  // `reported` is stamped once by runReconciliation over the finished list.
): Omit<VarianceRowOut, "reported">[] {
  const out: Omit<VarianceRowOut, "reported">[] = [];

  // Index OUT views by normalized SO.
  const outBySo = new Map<string, BarcodeView>();
  for (const v of Array.from(outViews.values())) {
    const so = normalizeSO(v.soNumber);
    if (so) outBySo.set(so, v);
  }

  for (const inView of Array.from(inViews.values())) {
    const so = normalizeSO(inView.soNumber);
    if (!so) continue;
    const outView = outBySo.get(so);
    if (!outView) continue;
    if (outView.canonical !== inView.canonical) continue; // same physical unit

    // Skip if either leg is already fully suppressed.
    if (
      suppressed.has(`IN::${inView.canonical}`) ||
      suppressed.has(`OUT::${outView.canonical}`)
    ) {
      continue;
    }

    const outDone = hasDone(outView.D);
    // Read job type across BOTH legs (Section 7).
    const jobTypes = [inView.jobType, outView.jobType];
    const anyRepairEquivalent = jobTypes.some(isRepairEquivalent);
    const anyNewRentalOrReplace = jobTypes.some(
      (j) => isNewRental(j) || isRepairEquivalent(j)
    );

    // Direction-Conflict Failed-Delivery Suppression: NEW_RENTAL/REPLACE and
    // the OUT delivery did not complete → suppress. BUT if OUT is done, fire
    // anyway even for REPLACE (a completed replacement + same-SO return is a
    // genuine conflict to check).
    if (!outDone && (anyNewRentalOrReplace || anyRepairEquivalent)) {
      continue;
    }

    out.push({
      barcode: inView.canonical,
      city: inView.city,
      direction: "CROSS",
      variance_name: VARIANCE.REPLACEMENT_CONFIRM,
      priority: "High",
      bucket: "REAL",
      responsible: "warehouse_team",
      ticket_id: inView.ticketId ?? outView.ticketId,
      so_number: inView.soNumber ?? outView.soNumber,
      customer: inView.customer ?? outView.customer,
      product: inView.product ?? outView.product,
      job_type: inView.jobType ?? outView.jobType,
      date: inView.date || outView.date,
      // The UNION of both legs, not the IN leg alone. This row asserts that one
      // unit both arrived and left today, so the evidence for that claim is
      // everything either leg saw. Reading only the IN leg would print "no
      // delivery-app record" for a unit whose OUT leg is the very reason the
      // row exists. It is consistent with how the identifying fields above
      // already merge (`inView.X ?? outView.X` — either leg counts).
      //
      // Lossy by design: it cannot say WHICH leg the gate logged. A CROSS row
      // is a single "confirm this replacement" ask, not two chase items, and
      // eight more columns for one variance name is not worth the schema.
      present: orFlags(presenceOf(inView), presenceOf(outView)),
      note: `Same unit (SO ${so}) both received and dispatched today — confirm it is a genuine same-day replacement and not a double-count.`,
    });
  }

  return out;
}
