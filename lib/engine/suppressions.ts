// Section 7 — Suppression fixes. These run BEFORE variance classification and
// catch operationally-normal situations that would otherwise look like fake
// variances. Returns the set of suppressed keys plus the DT-all-pending set
// (which also suppresses duplicate-scan variances) and the silent-OCR set
// (which must never appear anywhere in the output — Section 7/12).

import { blank, isRepair, normalizeSO } from "./util";
import { allPendingOrNotDone, hasDone } from "./views";
import type { BarcodeView } from "./types";

export interface SuppressionResult {
  suppressed: Set<string>; // `${direction}::${canonical}` — remove all variances
  dtAllPending: Set<string>; // subset — also suppresses duplicate variances
  silentOcr: Set<string>; // never output at all (Section 7 Silent OCR/SO-Match)
}

const key = (v: BarcodeView) => `${v.direction}::${v.canonical}`;

function productPrefixMatch(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const pa = a.trim().toLowerCase().split(/\s+/)[0];
  const pb = b.trim().toLowerCase().split(/\s+/)[0];
  if (!pa || !pb) return false;
  return pa === pb || pa.startsWith(pb) || pb.startsWith(pa);
}

export function computeSuppressions(
  inViews: Map<string, BarcodeView>,
  outViews: Map<string, BarcodeView>
): SuppressionResult {
  const suppressed = new Set<string>();
  const dtAllPending = new Set<string>();
  const silentOcr = new Set<string>();

  // Physical SO/ticket → [{canonical, product}] index for Silent OCR match.
  const physIndex = new Map<string, Array<{ canonical: string; product: string | null }>>();
  const indexPhysical = (views: Map<string, BarcodeView>) => {
    for (const v of Array.from(views.values())) {
      if (!v.P.present) continue;
      for (const id of [normalizeSO(v.soNumber), v.ticketId?.toUpperCase() ?? null]) {
        if (!id) continue;
        const list = physIndex.get(id) ?? [];
        list.push({ canonical: v.canonical, product: v.product });
        physIndex.set(id, list);
      }
    }
  };
  indexPhysical(inViews);
  indexPhysical(outViews);

  const evalDirection = (
    views: Map<string, BarcodeView>,
    opposite: Map<string, BarcodeView>,
    direction: "IN" | "OUT"
  ) => {
    for (const v of Array.from(views.values())) {
      const k = key(v);
      const opp = opposite.get(v.canonical);

      // DT All-Pending: every DT entry pending/not_done → suppress everything.
      if (allPendingOrNotDone(v.D)) {
        suppressed.add(k);
        dtAllPending.add(k);
        continue;
      }

      // Failed Delivery Return Suppression (IN).
      if (direction === "IN") {
        const sheetReceived = hasDone(v.S);
        const dtPending =
          v.D.present && !hasDone(v.D) &&
          v.D.statuses.some((s) => s === "pending" || s === "not_done");
        const oppDtPending =
          !!opp && opp.D.present && !hasDone(opp.D);
        if (sheetReceived && !v.P.present && dtPending && !v.O.present && oppDtPending) {
          suppressed.add(k);
          continue;
        }

        // WH Received-Back Undelivered Suppression (IN).
        const physOrSheetDone = hasDone(v.P) || hasDone(v.S);
        const dtAbsentOrNotDone = !v.D.present || !hasDone(v.D);
        if (physOrSheetDone && dtAbsentOrNotDone && !v.O.present && oppDtPending) {
          suppressed.add(k);
          continue;
        }
      }

      // Internal Repair Movement Suppression (OUT).
      if (direction === "OUT") {
        if (
          v.O.present &&
          isRepair(v.jobType) &&
          blank(v.ticketId) &&
          blank(v.customer) &&
          blank(v.soNumber)
        ) {
          suppressed.add(k);
          continue;
        }
      }

      // Silent OCR/SO-Match: barcode missing from physical, but the same SO or
      // ticket appears under a DIFFERENT canonical in physical for the same
      // product. Suppress silently — must never appear anywhere.
      if (!v.P.present) {
        const ids = [normalizeSO(v.soNumber), v.ticketId?.toUpperCase() ?? null];
        for (const id of ids) {
          if (!id) continue;
          const matches = physIndex.get(id) ?? [];
          if (
            matches.some(
              (m) => m.canonical !== v.canonical && productPrefixMatch(m.product, v.product)
            )
          ) {
            suppressed.add(k);
            silentOcr.add(k);
            break;
          }
        }
      }
    }
  };

  evalDirection(inViews, outViews, "IN");
  evalDirection(outViews, inViews, "OUT");

  return { suppressed, dtAllPending, silentOcr };
}
