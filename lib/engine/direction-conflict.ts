// Section 8 — Cross-Direction Check (Direction Conflict). A barcode that
// appears in both the IN and OUT union with the SAME normalized SO number is
// normally a same-day replacement, not a stock gap. Suppress via the
// Replace-as-Repair and Direction-Conflict Failed-Delivery fixes (Section 7);
// otherwise emit a Direction Conflict (High, direction CROSS).

import { isNewRental, isRepairEquivalent, normalizeSO } from "./util";
import { hasDone } from "./views";
import type { BarcodeView, VarianceRowOut } from "./types";

export function detectDirectionConflicts(
  inViews: Map<string, BarcodeView>,
  outViews: Map<string, BarcodeView>,
  suppressed: Set<string>
): VarianceRowOut[] {
  const out: VarianceRowOut[] = [];

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
      variance_name: "Direction Conflict",
      priority: "High",
      bucket: "REAL",
      responsible: "warehouse_team",
      ticket_id: inView.ticketId ?? outView.ticketId,
      so_number: inView.soNumber ?? outView.soNumber,
      customer: inView.customer ?? outView.customer,
      product: inView.product ?? outView.product,
      job_type: inView.jobType ?? outView.jobType,
      date: inView.date || outView.date,
      note: `Same unit (SO ${so}) both received and dispatched today — confirm it is a genuine same-day replacement and not a double-count.`,
    });
  }

  return out;
}
