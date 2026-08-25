// Applying a batch from a phone.
//
// THE WHOLE DESIGN IN ONE LINE: the device owns its own identifiers, the server
// owns everything else.
//
// A phone that has been offline for four hours arrives with a trip, forty
// scans, a shift and three face checks, in whatever order it queued them, and
// possibly for the second time because the first response never came back. All
// four of those facts have to be survivable:
//
//   REPLAY      every row carries a client id with a UNIQUE constraint, so a
//               re-send is a no-op rather than a double-count. Double-counting
//               an OUT movement is worse than missing one -- it invents stock
//               leaving the building.
//   ORDER       scans reference their trip by CLIENT id, and trips are applied
//               first, so a batch is order-independent.
//   PARTIAL     one bad row must not reject the batch. Each item gets its own
//               verdict and the phone clears only what landed.
//   AUTHORITY   the device proposes; the server decides business date, city,
//               site, geofence and photo sampling. A phone is the least
//               trustworthy thing in the system and the easiest to tamper with.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { GateIdentity } from "./auth";
import { resolveBusinessDate } from "./business-date";
import { geoOk, isCounted, loadSite, INWARD_ONLY_KINDS, OUTWARD_PHOTO_SAMPLE_RATE,
         type GateSite } from "./config";
import type { Direction } from "../engine/types";
import type { GateItemKind } from "../db/schema";

/** What the completeness check found, sent with the trip's close. */
export interface InCompleteness {
  expectedTotal: number;
  expectedScanned: number;
  /** The barcodes themselves — a count cannot be investigated the next
   *  morning, and this is evidence rather than a metric. */
  missing: string[];
  unplannedCount: number;
  /** Was the guard actually SHOWN this? False through the silent pilot. */
  warned: boolean;
  listAgeS?: number | null;
}

export interface InTrip {
  clientTripId: string;
  direction: Direction;
  vehicleNo: string;
  driverName?: string | null;
  carrierRef?: string | null;
  openedAt: string;
  closedAt?: string | null;
  status?: "open" | "closed" | "abandoned";
  notes?: string | null;
  completeness?: InCompleteness | null;
}

export interface InScan {
  clientScanId: string;
  clientTripId: string;
  barcode?: string | null;
  serialNo?: string | null;
  itemKind?: GateItemKind;
  quantity?: number;
  entryMethod: "scan" | "manual";
  product?: string | null;
  soNumber?: string | null;
  ticketId?: string | null;
  customer?: string | null;
  /** True when the phone captured an image for this row; the server hands back
   *  an upload link and the bytes follow separately. */
  hasPhoto?: boolean;
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  scannedAt: string;
  overrideReason?: string | null;
  exceptionReason?: string | null;
  notes?: string | null;
}

/**
 * A scan the guard has taken back.
 *
 * Retraction, not deletion: the row stays, its status becomes 'void' and the
 * reason is recorded. The gate register is meant to be a source of truth for a
 * reconciliation nobody can argue with, and a source that can quietly erase its
 * own history is not one. The reconciler reads status='recorded' only, so a
 * voided row stops counting the moment this lands.
 */
export interface InVoid {
  clientScanId: string;
  reason: string;
  voidedAt: string;
}

export interface InShift {
  clientShiftId: string;
  checkedInAt: string;
  checkedOutAt?: string | null;
  status?: "open" | "closed";
  inLat?: number | null; inLng?: number | null;
  outLat?: number | null; outLng?: number | null;
}

export interface InFaceCheck {
  clientCheckId: string;
  clientShiftId?: string | null;
  trigger: "check_in" | "check_out" | "random";
  capturedAt: string;
  /** On-device similarity. The image never leaves the phone for comparison. */
  matchScore?: number | null;
  verdict: "pass" | "review" | "fail" | "no_face" | "skipped";
  hasSelfie?: boolean;
  lat?: number | null; lng?: number | null;
}

export type ItemOutcome =
  | { clientId: string; status: "stored"; id: string; photoUploadPath?: string }
  | { clientId: string; status: "duplicate" }
  | { clientId: string; status: "rejected"; reason: string };

export interface SyncReport {
  trips: ItemOutcome[];
  scans: ItemOutcome[];
  voids: ItemOutcome[];
  shifts: ItemOutcome[];
  faceChecks: ItemOutcome[];
  /** Rows whose device clock looked wrong. Surfaced, never a rejection. */
  clockWarnings: string[];
}

const bad = (clientId: string, reason: string): ItemOutcome =>
  ({ clientId, status: "rejected", reason });

/**
 * Should this clean outward scan be photographed?
 *
 * Decided SERVER-SIDE, never by the phone. If the device chose, a guard wanting
 * to avoid photographing a particular item would only need the app to say no —
 * and the whole value of a spot-check is that the person being checked cannot
 * predict it.
 */
function drawPhotoSample(direction: Direction, entryMethod: string): boolean {
  if (direction !== "OUT" || entryMethod !== "scan") return false;
  return Math.random() < OUTWARD_PHOTO_SAMPLE_RATE;
}

/**
 * The completeness columns, from what the phone reported.
 *
 * Clamped rather than trusted. The phone computes this and a phone is the least
 * trustworthy thing in the system; a scanned count above the planned total
 * would violate the CHECK constraint and reject an otherwise good trip close,
 * which is a far worse outcome than a slightly wrong statistic.
 */
interface CompletenessColumns {
  expected_checked_at?: string;
  expected_total?: number;
  expected_scanned?: number;
  expected_missing?: string[];
  unplanned_count?: number;
  expected_warned?: boolean;
  expected_list_age_s?: number | null;
}

function completenessColumns(c: InCompleteness | null | undefined): CompletenessColumns {
  if (!c) return {};
  const total = Math.max(0, Math.trunc(c.expectedTotal ?? 0));
  const scanned = Math.min(total, Math.max(0, Math.trunc(c.expectedScanned ?? 0)));
  return {
    expected_checked_at: new Date().toISOString(),
    expected_total: total,
    expected_scanned: scanned,
    expected_missing: Array.isArray(c.missing) ? c.missing.slice(0, 500) : [],
    unplanned_count: Math.max(0, Math.trunc(c.unplannedCount ?? 0)),
    expected_warned: !!c.warned,
    expected_list_age_s: c.listAgeS == null ? null : Math.max(0, Math.trunc(c.listAgeS)),
  };
}

export async function applyBatch(
  admin: SupabaseClient,
  who: GateIdentity,
  batch: { trips?: InTrip[]; scans?: InScan[]; voids?: InVoid[];
           shifts?: InShift[]; faceChecks?: InFaceCheck[] },
  now: Date = new Date()
): Promise<SyncReport> {
  const report: SyncReport = { trips: [], scans: [], voids: [], shifts: [], faceChecks: [], clockWarnings: [] };
  // One lookup for the whole batch. A forty-scan sync should not ask the
  // database forty times where the gate is.
  const site: GateSite | null = await loadSite(admin, who.city).catch(() => null);
  // client_trip_id -> server uuid, for the scans that follow in this same batch.
  const tripIds = new Map<string, string>();

  // ── 1. Trips first, so scans can resolve their parent ────────────────────
  for (const t of batch.trips ?? []) {
    if (!t.clientTripId) { report.trips.push(bad("(missing id)", "clientTripId required")); continue; }
    if (t.direction !== "IN" && t.direction !== "OUT") {
      report.trips.push(bad(t.clientTripId, "direction must be IN or OUT")); continue;
    }
    // Every movement travels on a vehicle — confirmed with operations. A blank
    // registration is not a trip we are willing to record.
    if (!t.vehicleNo?.trim()) {
      report.trips.push(bad(t.clientTripId, "vehicleNo required")); continue;
    }
    const d = resolveBusinessDate(t.openedAt, now);
    if (!d) { report.trips.push(bad(t.clientTripId, "openedAt is not a valid instant")); continue; }
    if (d.suspectClock) report.clockWarnings.push(`trip ${t.clientTripId}: device clock off by ${Math.round(d.skewMs/60000)} min`);

    const row = {
      client_trip_id: t.clientTripId,
      city: who.city,
      site_code: who.siteCode,
      direction: t.direction,
      vehicle_no: t.vehicleNo.trim().toUpperCase(),
      driver_name: t.driverName?.trim() || null,
      carrier_ref: t.carrierRef?.trim() || null,
      opened_at: t.openedAt,
      closed_at: t.closedAt ?? null,
      business_date: d.businessDate,
      guard_id: who.guardId,
      device_id: who.deviceId,
      status: t.status ?? "open",
      notes: t.notes?.trim() || null,
      ...completenessColumns(t.completeness),
    };

    const ins = await admin.from("gate_trips").insert(row).select("id").maybeSingle();
    if (ins.error) {
      // 23505 = the client id is already stored, i.e. this is a replay. Look up
      // what we kept last time so the scans in this batch still resolve — a
      // replayed trip must not orphan the scans that came with it.
      if (ins.error.code === "23505") {
        const { data } = await admin.from("gate_trips")
          .select("id").eq("client_trip_id", t.clientTripId).maybeSingle();
        if (data?.id) {
          tripIds.set(t.clientTripId, data.id as string);
          // A CLOSE arriving for an already-stored trip is an update, not a
          // duplicate: the phone opened it in one batch and closed it in a
          // later one, which is the normal shape of a real trip.
          if (t.status === "closed" && t.closedAt) {
            // The completeness result arrives HERE in practice, not on the
            // insert: a trip is opened in one batch and closed in a later one,
            // so an update that dropped these columns would have recorded the
            // gap precisely never.
            await admin.from("gate_trips")
              .update({ status: "closed", closed_at: t.closedAt,
                        ...completenessColumns(t.completeness) })
              .eq("id", data.id).eq("status", "open");
          }
        }
        report.trips.push({ clientId: t.clientTripId, status: "duplicate" });
      } else {
        report.trips.push(bad(t.clientTripId, ins.error.message));
      }
      continue;
    }
    tripIds.set(t.clientTripId, ins.data!.id as string);
    report.trips.push({ clientId: t.clientTripId, status: "stored", id: ins.data!.id as string });
  }

  // ── 2. Scans ─────────────────────────────────────────────────────────────
  for (const sc of batch.scans ?? []) {
    if (!sc.clientScanId) { report.scans.push(bad("(missing id)", "clientScanId required")); continue; }

    let tripId = tripIds.get(sc.clientTripId);
    if (!tripId) {
      const { data } = await admin.from("gate_trips")
        .select("id, direction").eq("client_trip_id", sc.clientTripId).maybeSingle();
      if (!data) { report.scans.push(bad(sc.clientScanId, "unknown trip")); continue; }
      tripId = data.id as string;
      tripIds.set(sc.clientTripId, tripId);
    }
    const { data: trip } = await admin.from("gate_trips")
      .select("direction, business_date").eq("id", tripId).maybeSingle();
    if (!trip) { report.scans.push(bad(sc.clientScanId, "unknown trip")); continue; }
    const direction = trip.direction as Direction;

    const kind: GateItemKind = sc.itemKind ?? "unit";
    const counted = isCounted(kind);

    if (INWARD_ONLY_KINDS.includes(kind) && direction !== "IN") {
      report.scans.push(bad(sc.clientScanId, `${kind} can only arrive, not leave`)); continue;
    }
    if (sc.entryMethod !== "scan" && sc.entryMethod !== "manual") {
      report.scans.push(bad(sc.clientScanId, "entryMethod must be scan or manual")); continue;
    }
    // A scan is a QR read by definition; anything typed is manual. Keeping the
    // two in step here means a row can never claim more trust than it has.
    const barcodeSource = sc.entryMethod === "scan" ? "qr"
      : sc.barcode ? "manual" : "pending";

    if (sc.entryMethod === "scan" && !sc.barcode?.trim()) {
      report.scans.push(bad(sc.clientScanId, "a scan must carry a barcode")); continue;
    }
    // Manual entries and overrides are evidence-bearing: nothing else in the
    // row proves anything, so the photo is not optional.
    if ((sc.entryMethod === "manual" || sc.overrideReason) && !sc.hasPhoto) {
      report.scans.push(bad(sc.clientScanId, "a photo is required for manual entries and overrides")); continue;
    }
    if (!counted && !sc.barcode?.trim() &&
        !(direction === "IN" && (sc.serialNo || sc.soNumber || sc.ticketId))) {
      report.scans.push(bad(sc.clientScanId, "an identified item needs a barcode, serial, order or ticket")); continue;
    }
    const qty = Math.max(1, Math.trunc(sc.quantity ?? 1));
    if ((kind === "unit" || kind === "customer_return") && qty !== 1) {
      report.scans.push(bad(sc.clientScanId, `${kind} is a single unit`)); continue;
    }

    const d = resolveBusinessDate(sc.scannedAt, now);
    if (!d) { report.scans.push(bad(sc.clientScanId, "scannedAt is not a valid instant")); continue; }
    if (d.suspectClock) report.clockWarnings.push(`scan ${sc.clientScanId}: device clock off by ${Math.round(d.skewMs/60000)} min`);

    const sampled = drawPhotoSample(direction, sc.entryMethod);
    const needsPhoto = !!sc.hasPhoto || sampled;
    const photoPath = needsPhoto
      ? `${who.city}/${d.businessDate}/${sc.clientScanId}.jpg` : null;

    // An untagged customer return is an anomaly, not a routine arrival: the
    // unit WAS tagged when it left, so a missing sticker means it came off.
    // The reason is what puts it in front of a human.
    const untaggedReturn = kind === "customer_return" && !sc.barcode?.trim();
    const exception = sc.exceptionReason?.trim()
      || (untaggedReturn ? "returned without its barcode sticker" : null);

    const row = {
      client_scan_id: sc.clientScanId,
      trip_id: tripId,
      city: who.city,
      site_code: who.siteCode,
      direction,
      business_date: d.businessDate,
      // Stored EXACTLY as the QR returned it. Never folded — the fold is why
      // 57% of items display a barcode matching nothing in any system.
      barcode: sc.barcode?.trim() || null,
      barcode_source: barcodeSource,
      serial_no: sc.serialNo?.trim() || null,
      item_kind: kind,
      quantity: qty,
      entry_method: sc.entryMethod,
      product: sc.product?.trim() || null,
      so_number: sc.soNumber?.trim() || null,
      ticket_id: sc.ticketId?.trim() || null,
      customer: sc.customer?.trim() || null,
      photo_path: photoPath,
      photo_sampled: sampled,
      lat: sc.lat ?? null,
      lng: sc.lng ?? null,
      accuracy_m: sc.accuracyM ?? null,
      geo_ok: geoOk(site, sc.lat, sc.lng),
      scanned_at: sc.scannedAt,
      guard_id: who.guardId,
      device_id: who.deviceId,
      expected_match: "unchecked" as const,
      override_reason: sc.overrideReason?.trim() || null,
      barcode_pending: !sc.barcode?.trim() && !counted,
      exception_reason: exception,
      notes: sc.notes?.trim() || null,
    };

    const ins = await admin.from("gate_scans").insert(row).select("id").maybeSingle();
    if (ins.error) {
      if (ins.error.code === "23505") {
        // Either a replay of this scan, or the same barcode already on this
        // trip. Both are "already accounted for" from the phone's side, and
        // both must clear from its outbox — a row it keeps retrying forever is
        // a queue that never drains.
        report.scans.push({ clientId: sc.clientScanId, status: "duplicate" });
      } else {
        report.scans.push(bad(sc.clientScanId, ins.error.message));
      }
      continue;
    }
    report.scans.push({
      clientId: sc.clientScanId, status: "stored", id: ins.data!.id as string,
      ...(photoPath ? { photoUploadPath: photoPath } : {}),
    });
  }

  // ── 3. Retractions ───────────────────────────────────────────────────────
  // AFTER the scans, never before. A guard can scan an item and remove it again
  // inside the same offline batch, and applying the void first would leave the
  // scan behind it as a live row -- the exact double-count this is meant to
  // prevent.
  for (const v of batch.voids ?? []) {
    if (!v.clientScanId) { report.voids.push(bad("(missing id)", "clientScanId required")); continue; }
    if (!v.reason?.trim()) { report.voids.push(bad(v.clientScanId, "a void needs a reason")); continue; }

    // Scoped to this guard's own city. A phone cannot reach across gates and
    // erase somebody else's movement, which is the mistake a client-supplied
    // identifier invites by default.
    const { data, error } = await admin.from("gate_scans")
      .update({ status: "void", void_reason: v.reason.trim(), voided_at: v.voidedAt,
                voided_by: who.guardId })
      .eq("client_scan_id", v.clientScanId)
      .eq("city", who.city)
      .select("id");

    if (error) { report.voids.push(bad(v.clientScanId, error.message)); continue; }
    // Nothing updated means either an already-voided row or a scan this server
    // never saw. Both are "the phone's wish is granted" from the queue's point
    // of view, and a retraction it retries forever is a queue that never
    // drains.
    report.voids.push(data && data.length
      ? { clientId: v.clientScanId, status: "stored", id: data[0].id as string }
      : { clientId: v.clientScanId, status: "duplicate" });
  }

  // ── 3. Attendance ────────────────────────────────────────────────────────
  // Applied after movements on purpose: if the batch is truncated or the
  // function is killed, the movements are what must survive. Attendance can be
  // re-sent; a lost scan is a unit nobody can account for.
  const shiftIds = new Map<string, string>();
  for (const sh of batch.shifts ?? []) {
    if (!sh.clientShiftId) { report.shifts.push(bad("(missing id)", "clientShiftId required")); continue; }
    const d = resolveBusinessDate(sh.checkedInAt, now);
    if (!d) { report.shifts.push(bad(sh.clientShiftId, "checkedInAt is not a valid instant")); continue; }

    const row = {
      client_shift_id: sh.clientShiftId,
      guard_id: who.guardId, city: who.city, site_code: who.siteCode,
      device_id: who.deviceId,
      checked_in_at: sh.checkedInAt,
      checked_out_at: sh.checkedOutAt ?? null,
      business_date: d.businessDate,
      in_lat: sh.inLat ?? null, in_lng: sh.inLng ?? null,
      in_geo_ok: geoOk(site, sh.inLat, sh.inLng),
      out_lat: sh.outLat ?? null, out_lng: sh.outLng ?? null,
      out_geo_ok: geoOk(site, sh.outLat, sh.outLng),
      status: sh.status ?? "open",
    };
    const ins = await admin.from("guard_shifts").insert(row).select("id").maybeSingle();
    if (ins.error) {
      if (ins.error.code === "23505") {
        const { data } = await admin.from("guard_shifts")
          .select("id").eq("client_shift_id", sh.clientShiftId).maybeSingle();
        if (data?.id) {
          shiftIds.set(sh.clientShiftId, data.id as string);
          // Check-out reaching us in a later batch than check-in is the normal
          // shape of a shift, not a duplicate.
          if (sh.checkedOutAt) {
            await admin.from("guard_shifts")
              .update({ status: "closed", checked_out_at: sh.checkedOutAt,
                        out_lat: sh.outLat ?? null, out_lng: sh.outLng ?? null,
                        out_geo_ok: geoOk(site, sh.outLat, sh.outLng) })
              .eq("id", data.id).eq("status", "open");
          }
        }
        report.shifts.push({ clientId: sh.clientShiftId, status: "duplicate" });
      } else report.shifts.push(bad(sh.clientShiftId, ins.error.message));
      continue;
    }
    shiftIds.set(sh.clientShiftId, ins.data!.id as string);
    report.shifts.push({ clientId: sh.clientShiftId, status: "stored", id: ins.data!.id as string });
  }

  for (const f of batch.faceChecks ?? []) {
    if (!f.clientCheckId) { report.faceChecks.push(bad("(missing id)", "clientCheckId required")); continue; }
    let shiftId = f.clientShiftId ? shiftIds.get(f.clientShiftId) ?? null : null;
    if (!shiftId && f.clientShiftId) {
      const { data } = await admin.from("guard_shifts")
        .select("id").eq("client_shift_id", f.clientShiftId).maybeSingle();
      shiftId = (data?.id as string) ?? null;
    }
    const d = resolveBusinessDate(f.capturedAt, now);
    if (!d) { report.faceChecks.push(bad(f.clientCheckId, "capturedAt is not a valid instant")); continue; }

    // Anything short of a clean pass goes to a human. NEVER a lockout: gate
    // lighting at night is poor, and a guard refused entry at 9pm stops using
    // the app for good — which leaves no attendance record at all.
    const review = f.verdict === "pass" ? "none" : "pending";
    const selfiePath = f.hasSelfie
      ? `${who.city}/${d.businessDate}/${f.clientCheckId}.jpg` : null;

    const ins = await admin.from("guard_face_checks").insert({
      client_check_id: f.clientCheckId,
      shift_id: shiftId, guard_id: who.guardId, city: who.city,
      device_id: who.deviceId, trigger: f.trigger,
      captured_at: f.capturedAt, selfie_path: selfiePath,
      match_score: f.matchScore ?? null, verdict: f.verdict,
      lat: f.lat ?? null, lng: f.lng ?? null,
      geo_ok: geoOk(site, f.lat, f.lng),
      review_state: review,
    }).select("id").maybeSingle();

    if (ins.error) {
      report.faceChecks.push(ins.error.code === "23505"
        ? { clientId: f.clientCheckId, status: "duplicate" }
        : bad(f.clientCheckId, ins.error.message));
      continue;
    }
    report.faceChecks.push({
      clientId: f.clientCheckId, status: "stored", id: ins.data!.id as string,
      ...(selfiePath ? { photoUploadPath: selfiePath } : {}),
    });
  }

  return report;
}
