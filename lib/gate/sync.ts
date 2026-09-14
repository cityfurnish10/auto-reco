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
//               site and geofence. A phone is the least
//               trustworthy thing in the system and the easiest to tamper with.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { GateIdentity } from "./auth";
import { resolveBusinessDate } from "./business-date";
import { geoOk, isCounted, loadSite, INWARD_ONLY_KINDS,
         type GateSite } from "./config";
import type { Direction } from "../engine/types";
import type { GateItemKind } from "../db/schema";
import { canonicalize } from "../engine/barcode";
import { istDateOf, isIsoDate, shiftIstDate } from "./calendar";

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
  /** Set when the guard chose YESTERDAY for this trip (0044). Accepted only
   *  as the calendar day before openedAt; anything else is ignored. */
  movementDate?: string | null;
  /** The phone holds a photo of how the stock sits in the vehicle (0045). */
  hasVehiclePhoto?: boolean;
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
  /** The guard asserts the gate was quiet. Refused below if their scans say
   *  otherwise — a confident zero has to be earned, not merely claimed. */
  nothingMoved?: boolean;
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
  // A replay may still owe its photo: the first upload can fail after the row
  // was stored, and the phone keeps the image until one succeeds.
  | { clientId: string; status: "duplicate"; photoUploadPath?: string }
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

/**
 * What goes in `driver_name` when a trip arrives without one.
 *
 * Deliberately not a name and deliberately not blank: blank is refused by the
 * constraint, and anything name-shaped would be read as a person. This says
 * what happened, survives the constraint, and is greppable.
 */
export const NO_AGENT_RECORDED = "(not recorded)";

const bad = (clientId: string, reason: string): ItemOutcome =>
  ({ clientId, status: "rejected", reason });

/**
 * Say why the database refused a row, in words.
 *
 * A refusal is read in two places by two people who cannot act on Postgres: the
 * guard, in Settings on the phone, and whoever opens the Reviews tab. Both were
 * being shown `new row for relation "gate_scans" violates check constraint
 * "gate_scans_outward_scan_required"` — which is precise, unactionable, and for
 * a guard reading the app in Hindi or Telugu, not even in their language.
 *
 * Mapped by CONSTRAINT NAME rather than by parsing the sentence around it:
 * the name is the stable part, and a Postgres upgrade that rewords the message
 * must not silently drop us back to showing it.
 *
 * The raw text is kept on anything unrecognised. A refusal nobody predicted is
 * exactly when the database's own words are worth more than a tidy guess.
 */
const CONSTRAINT_REASONS: Record<string, string> = {
  gate_scans_outward_scan_required:
    "an identified item leaving by hand needs a stated reason and a photo",
  gate_scans_manual_needs_photo: "an item added by hand needs a photo",
  gate_scans_override_needs_proof: "an override needs a reason and a photo",
  gate_scans_identifier_present:
    "this item needs a barcode, serial, order or ticket to identify it",
  gate_trips_agent_named: "a trip needs the delivery agent's name",
};

export function readableDbError(message: string): string {
  const m = message.match(/constraint "([^"]+)"/);
  const known = m ? CONSTRAINT_REASONS[m[1]] : undefined;
  // The constraint name travels with the sentence so an engineer reading the
  // Reviews tab still knows exactly which rule fired.
  return known && m ? `${known} (${m[1]})` : message;
}

/**
 * Write a refusal down where somebody other than the guard can read it.
 *
 * Every rejection already travels back to the phone, which marks it and keeps
 * it. That is right, and it is also a dead end: the only record of WHY three
 * manual items never arrived lived in browser storage on a handset at a gate.
 * A supervisor asking the question had nowhere to look.
 *
 * Best-effort by design. A logging failure must never turn a partially-accepted
 * batch into a rejected one — the movements are the point, this is the note.
 */
async function logRejections(
  admin: SupabaseClient,
  who: GateIdentity,
  kind: "trip" | "scan" | "void" | "shift" | "face",
  outcomes: ItemOutcome[],
  summarise: (clientId: string) => Record<string, unknown> | undefined,
  businessDate: string | null
): Promise<void> {
  const rows = outcomes
    .filter((o): o is Extract<ItemOutcome, { status: "rejected" }> => o.status === "rejected")
    .map((o) => ({
      client_id: o.clientId,
      kind,
      city: who.city,
      site_code: who.siteCode,
      guard_id: who.guardId,
      device_id: who.deviceRowId,
      reason: o.reason,
      summary: summarise(o.clientId) ?? null,
      business_date: businessDate,
      rejected_at: new Date().toISOString(),
    }));
  if (!rows.length) return;

  // A plain insert. A phone retries, so the same refusal arrives repeatedly —
  // a BEFORE INSERT trigger (0033) turns a repeat into an attempts++ on the row
  // it repeats, because PostgREST cannot express that conflict clause and
  // read-then-write from a serverless function races every other phone.
  //
  // try/catch rather than a rejection handler: against a client that does not
  // know this table, the call throws SYNCHRONOUSLY, which no `.then` can catch.
  // This is a note ABOUT failures and must never become one — the movements in
  // this batch are already stored.
  try {
    await admin.from("gate_sync_rejections").insert(rows);
  } catch { /* logging is never worth a batch */ }
}

/**
 * Should this clean outward scan be photographed?
 *
 * Decided SERVER-SIDE, never by the phone. If the device chose, a guard wanting
 * to avoid photographing a particular item would only need the app to say no —
 * and the whole value of a spot-check is that the person being checked cannot
 * predict it.
 */

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

/**
 * Attach what is known about a barcode, at the moment it arrives.
 *
 * ENRICHMENT MOVED HERE FROM THE PHONE, and the reason is structural rather
 * than tidiness. The device used to download the day's expected list so it
 * could label a scan itself — which meant the plan was sitting on the handset,
 * and the only thing stopping a guard seeing it was a rule I kept breaking.
 *
 * The gate is worth building because it is an INDEPENDENT witness. A guard who
 * can see what is expected scans against the expectation, and the record stops
 * being an observation. Now the phone holds nothing but what was scanned, and
 * showing the plan is impossible rather than merely forbidden.
 *
 * One lookup for the whole batch. A forty-scan sync should not ask the
 * database forty times what a barcode is.
 */
async function enrichScans(
  admin: SupabaseClient,
  who: GateIdentity,
  businessDate: string,
  barcodes: string[]
): Promise<Map<string, Record<string, unknown>>> {
  const found = new Map<string, Record<string, unknown>>();
  const wanted = [...new Set(barcodes.filter(Boolean))];
  if (!wanted.length) return found;

  // Matched on the FOLD as well as the true spelling: a scanned QR and a
  // planned line can differ by a confusable character and still be one label.
  const canon = [...new Set(wanted.map((b) => canonicalize(b)))];
  const { data } = await admin
    .from("gate_expected_items")
    .select("barcode,barcode_canon,product,so_number,ticket_id,customer,delivery_address,picking_ref,planned_by")
    .eq("city", who.city)
    .eq("business_date", businessDate)
    .or(`barcode.in.(${wanted.map((b) => `"${b}"`).join(",")}),` +
        `barcode_canon.in.(${canon.map((b) => `"${b}"`).join(",")})`);

  for (const row of (data ?? []) as Record<string, unknown>[]) {
    // Keyed both ways so a lookup succeeds whichever spelling the scan used.
    for (const k of [row.barcode, row.barcode_canon]) {
      if (k) found.set(canonicalize(String(k)), row);
    }
  }
  return found;
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

    // A TRIP WITH NO AGENT IS STILL A REAL MOVEMENT.
    //
    // The app has required an agent since 26 Aug and the database enforces it
    // (0030). But a phone can hold trips queued BEFORE that, and those arrive
    // now as new inserts — so the constraint refused them, forever, 31 retries
    // deep. Worse, a refused trip orphans every scan that belongs to it: three
    // real scans and a photographed manual entry were stuck behind four legacy
    // trips that could never be accepted.
    //
    // Refusing a movement to protect a data-quality rule is the wrong trade,
    // and it is the same mistake as treating silence as zero. The trip is
    // recorded with the gap named in the field itself, so nobody mistakes it
    // for a real agent and nothing is lost.
    const agent = t.driverName?.trim() || null;
    // RECORDED LATE: for yesterday, and nothing earlier. Checked here rather
    // than trusted from the phone, which only offers the two choices — a day
    // any further back is recorded as today, not refused, so the movement is
    // never lost over the date it claimed.
    const late = isIsoDate(t.movementDate) && t.movementDate === shiftIstDate(istDateOf(t.openedAt), -1);
    const vehiclePhotoPath = t.hasVehiclePhoto
      ? `${who.city}/${d.businessDate}/vehicle-${t.clientTripId}.jpg` : null;
    const row = {
      client_trip_id: t.clientTripId,
      city: who.city,
      site_code: who.siteCode,
      direction: t.direction,
      vehicle_no: t.vehicleNo.trim().toUpperCase(),
      driver_name: agent ?? NO_AGENT_RECORDED,
      carrier_ref: t.carrierRef?.trim() || null,
      opened_at: t.openedAt,
      ...(late ? { movement_date: t.movementDate, recorded_late: true } : {}),
      ...(vehiclePhotoPath ? { vehicle_photo_path: vehiclePhotoPath } : {}),
      closed_at: t.closedAt ?? null,
      // Counted on the day it moved, not the day it was typed in.
      business_date: late ? t.movementDate! : d.businessDate,
      guard_id: who.guardId,
      device_id: who.deviceId,
      status: t.status ?? "open",
      notes: t.notes?.trim() || null,
      ...completenessColumns(t.completeness),
    };

    let ins = await admin.from("gate_trips").insert(row).select("id").maybeSingle();
    // 0044 applied by hand, possibly not yet. Without its columns a late trip
    // could not be MARKED late, and backdating without the mark is the one
    // thing this feature must never do — so it is recorded on its own day.
    if (ins.error?.code === "42703" && vehiclePhotoPath && !late) {
      // 0045 not applied: record the trip; the photo has nowhere to point yet.
      const { vehicle_photo_path: _v, ...plain } = row as typeof row & { vehicle_photo_path?: unknown };
      void _v;
      ins = await admin.from("gate_trips").insert(plain).select("id").maybeSingle();
      report.clockWarnings.push(`trip ${t.clientTripId}: vehicle photo not stored — migration 0045 not applied`);
    }
    if (ins.error?.code === "42703" && late) {
      const { movement_date: _m, recorded_late: _r, ...plain } = row as typeof row & { movement_date?: unknown; recorded_late?: unknown };
      void _m; void _r;
      ins = await admin.from("gate_trips").insert({ ...plain, business_date: d.businessDate }).select("id").maybeSingle();
      report.clockWarnings.push(`trip ${t.clientTripId}: recorded for yesterday, stored as today — migration 0044 not applied`);
    }
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
          // The vehicle photo arrives with the close, which for a real trip is
          // this update path. Pointed at once; a replay only re-offers the link.
          if (vehiclePhotoPath) {
            await admin.from("gate_trips").update({ vehicle_photo_path: vehiclePhotoPath })
              .eq("id", data.id).is("vehicle_photo_path", null)
              .then(() => undefined, () => undefined);
          }
        }
        report.trips.push({ clientId: t.clientTripId, status: "duplicate",
                            ...(vehiclePhotoPath ? { photoUploadPath: vehiclePhotoPath } : {}) });
      } else {
        report.trips.push(bad(t.clientTripId, readableDbError(ins.error.message)));
      }
      continue;
    }
    tripIds.set(t.clientTripId, ins.data!.id as string);
    report.trips.push({ clientId: t.clientTripId, status: "stored", id: ins.data!.id as string,
                        ...(vehiclePhotoPath ? { photoUploadPath: vehiclePhotoPath } : {}) });
  }

  // ── 2. Scans ─────────────────────────────────────────────────────────────
  // What is known about these barcodes, looked up ONCE for the whole batch.
  // The phone sends a bare scan; everything a person would want to read about
  // it is attached here. See enrichScans for why this is not done on the
  // device.
  const scanDate = resolveBusinessDate(
    batch.scans?.[0]?.scannedAt ?? now.toISOString(), now
  )?.businessDate ?? null;
  const known = scanDate
    ? await enrichScans(admin, who, scanDate,
        (batch.scans ?? []).map((x) => x.barcode ?? "").filter(Boolean))
        .catch(() => new Map<string, Record<string, unknown>>())
    : new Map<string, Record<string, unknown>>();

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
    let tripRead = await admin.from("gate_trips")
      .select("direction, business_date, recorded_late").eq("id", tripId).maybeSingle();
    if (tripRead.error?.code === "42703") {
      tripRead = await admin.from("gate_trips").select("direction, business_date").eq("id", tripId).maybeSingle() as typeof tripRead;
    }
    const trip = tripRead.data as { direction: string; business_date: string; recorded_late?: boolean } | null;
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
    // Mirrors gate_scans_outward_scan_required (0023, narrowed by 0041). The
    // constraint is the control and stays the control — a phone ships in
    // versions and an old build lingers for weeks. This exists so a refusal
    // arrives as a sentence a guard can act on instead of the Postgres one,
    // which is what both the phone and the Reviews tab showed for every manual
    // outward entry the app has ever produced.
    //
    // A counted kind has no sticker to scan, so the rule does not reach it;
    // its photo is demanded above.
    if (direction === "OUT" && sc.entryMethod !== "scan" && !counted
        && !sc.exceptionReason?.trim()) {
      report.scans.push(bad(sc.clientScanId,
        "an identified item leaving by hand needs a stated reason")); continue;
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

    // Looked up on the FOLD so a confusable character does not lose the match.
    const match = sc.barcode ? known.get(canonicalize(sc.barcode.trim())) : undefined;

    // A photo path only for a photo the phone actually took. This used to add
    // a random 10% sample of outward scans on top — decided HERE, after the
    // scan, with nothing on the phone told to take one. Measured 14 Sep 2026:
    // 16 of 16 sampled rows had a photo recorded and no file in storage, and
    // the manager's camera icon on each led to "missing". A spot-check photo
    // has to be asked for at the gate, before the item leaves, or it is not a
    // spot-check.
    const photoPath = sc.hasPhoto
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
      // A trip recorded for yesterday carries its scans with it (0044).
      business_date: trip.recorded_late ? trip.business_date : d.businessDate,
      ...(trip.recorded_late ? { recorded_late: true } : {}),
      // Stored EXACTLY as the QR returned it. Never folded — the fold is why
      // 57% of items display a barcode matching nothing in any system.
      barcode: sc.barcode?.trim() || null,
      barcode_source: barcodeSource,
      serial_no: sc.serialNo?.trim() || null,
      item_kind: kind,
      quantity: qty,
      entry_method: sc.entryMethod,
      // WHAT THE PHONE SENT, then what the server knows — in that order.
      // A manual entry carries details a guard typed and those must win; a
      // scan carries none, and the plan fills them in. Neither invents.
      product: sc.product?.trim() || (match?.product as string) || null,
      so_number: sc.soNumber?.trim() || (match?.so_number as string) || null,
      ticket_id: sc.ticketId?.trim() || (match?.ticket_id as string) || null,
      customer: sc.customer?.trim() || (match?.customer as string) || null,
      photo_path: photoPath,
      photo_sampled: false,
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
        //
        // A REPLAY of a scan with a photo is handed its upload link again. The
        // phone now holds the image until an upload succeeds, and this is how
        // a second attempt gets one. Looked up by this scan's own id, so a
        // different scan of the same barcode never gets another row's link.
        let replayPath: string | undefined;
        if (sc.hasPhoto) {
          const { data: prior } = await admin.from("gate_scans")
            .select("photo_path").eq("client_scan_id", sc.clientScanId).maybeSingle();
          replayPath = (prior?.photo_path as string | null) ?? undefined;
        }
        report.scans.push({ clientId: sc.clientScanId, status: "duplicate",
                            ...(replayPath ? { photoUploadPath: replayPath } : {}) });
      } else {
        report.scans.push(bad(sc.clientScanId, readableDbError(ins.error.message)));
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
      nothing_moved: false,   // never trusted on insert; settled at close below
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
            // "Nothing moved" is settled HERE, at close, and only after
            // checking. A phone claiming a quiet day on a shift that recorded
            // movements would turn a busy day into a confident zero in the
            // reconciliation — the single most damaging thing this flag could
            // do. Postgres cannot express the rule as a CHECK (it spans two
            // tables), so it is enforced here and read defensively again by
            // the connector.
            let quiet = false;
            if (sh.nothingMoved) {
              const { count } = await admin.from("gate_scans")
                .select("id", { count: "exact", head: true })
                .eq("guard_id", who.guardId)
                .eq("business_date", d.businessDate)
                .eq("status", "recorded");
              quiet = (count ?? 0) === 0;
            }
            await admin.from("guard_shifts")
              .update({ status: "closed", checked_out_at: sh.checkedOutAt,
                        out_lat: sh.outLat ?? null, out_lng: sh.outLng ?? null,
                        out_geo_ok: geoOk(site, sh.outLat, sh.outLng),
                        nothing_moved: quiet })
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
      if (ins.error.code === "23505") {
        // Same as a scan replay: a selfie whose first upload failed gets its
        // link again.
        let replayPath: string | undefined;
        if (f.hasSelfie) {
          const { data: prior } = await admin.from("guard_face_checks")
            .select("selfie_path").eq("client_check_id", f.clientCheckId).maybeSingle();
          replayPath = (prior?.selfie_path as string | null) ?? undefined;
        }
        report.faceChecks.push({ clientId: f.clientCheckId, status: "duplicate",
                                 ...(replayPath ? { photoUploadPath: replayPath } : {}) });
      } else {
        report.faceChecks.push(bad(f.clientCheckId, ins.error.message));
      }
      continue;
    }
    report.faceChecks.push({
      clientId: f.clientCheckId, status: "stored", id: ins.data!.id as string,
      ...(selfiePath ? { photoUploadPath: selfiePath } : {}),
    });
  }

  // ── 5. Write down anything we refused ────────────────────────────────────
  // LAST, and never allowed to fail the batch. The movements that were
  // accepted are already stored; this is the note that makes the refusals
  // answerable by somebody who is not holding the phone.
  //
  // The business date is taken from whatever the batch carried rather than
  // recomputed — a row refused BECAUSE its timestamp was unreadable has no
  // date, and inventing one would file it under a day it has nothing to do
  // with.
  const anyDate = resolveBusinessDate(
    batch.scans?.[0]?.scannedAt ?? batch.trips?.[0]?.openedAt ?? now.toISOString(), now
  )?.businessDate ?? null;

  const scanById = new Map((batch.scans ?? []).map((x) => [x.clientScanId, x]));
  const tripById = new Map((batch.trips ?? []).map((x) => [x.clientTripId, x]));

  await Promise.all([
    logRejections(admin, who, "scan", report.scans, (id) => {
      const x = scanById.get(id);
      if (!x) return undefined;
      // Enough to recognise the item, never the whole payload — we declined to
      // store this row and should not keep a shadow copy of it either.
      return { barcode: x.barcode ?? null, serialNo: x.serialNo ?? null,
               itemKind: x.itemKind ?? "unit", entryMethod: x.entryMethod,
               quantity: x.quantity ?? 1, hasPhoto: !!x.hasPhoto };
    }, anyDate),
    logRejections(admin, who, "trip", report.trips, (id) => {
      const x = tripById.get(id);
      return x ? { direction: x.direction, vehicleNo: x.vehicleNo,
                   driverName: x.driverName ?? null } : undefined;
    }, anyDate),
    logRejections(admin, who, "void", report.voids, () => undefined, anyDate),
    logRejections(admin, who, "shift", report.shifts, () => undefined, anyDate),
    logRejections(admin, who, "face", report.faceChecks, () => undefined, anyDate),
  ]);

  return report;
}
