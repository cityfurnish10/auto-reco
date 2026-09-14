// applyBatch is where a phone that has been offline for four hours meets the
// database. The failure that matters most is not rejection — it is a REPLAY
// quietly booking the same movement twice, which invents stock leaving the
// building and is indistinguishable from a real second dispatch afterwards.

import { describe, expect, it } from "vitest";
import { applyBatch, readableDbError, type InCompleteness, type InScan,
         type InTrip, type InVoid } from "../../lib/gate/sync";
import type { GateIdentity } from "../../lib/gate/auth";

const WHO: GateIdentity = {
  deviceRowId: "dev-row", deviceId: "dev-1", guardId: "guard-1",
  guardName: "Ramesh", city: "DELHI", siteCode: "GUR",
};

const trip = (o: Partial<InTrip> = {}): InTrip => ({
  clientTripId: "ct-1", direction: "OUT", vehicleNo: "hr26 dk 8337",
  openedAt: "2026-08-21T10:30:00Z", ...o,
});
const scan = (o: Partial<InScan> = {}): InScan => ({
  clientScanId: "cs-1", clientTripId: "ct-1", barcode: "FUL5ZA24120009",
  entryMethod: "scan", scannedAt: "2026-08-21T10:31:00Z", ...o,
});

/**
 * The CHECK constraints on gate_scans, as Postgres would apply them.
 *
 * ADDED AFTER THEY COST US EVERY MANUAL OUTWARD ENTRY. The stub enforced the
 * two unique constraints and nothing else, so a row the real database would
 * refuse was stored here without complaint. For the whole life of the gate app
 * a guard adding a spare part to an outward trip had it silently dropped —
 * 833 tests green, two refusals a day in production — because the rule that
 * refused it lived only in 0023 and no test could see it.
 *
 * Returning 23514 with the constraint name matters as much as the refusal: the
 * name is what readableDbError turns into a sentence a guard can act on, so a
 * generic "rejected" here would pass a test that proves nothing.
 *
 * Kept in step with supabase/migrations by hand, which is the same deal the
 * migrations themselves are on. A rule that is not here is a rule that can
 * break production while this file is green.
 */
const COUNTED = ["spare_part", "consumable", "pp_box", "sample"];
const CHECKS: [string, (r: Record<string, unknown>) => boolean][] = [
  // 0023, narrowed by 0041: outward must be scanned, unless it is a kind that
  // never had a sticker, or it states why it left by hand.
  ["gate_scans_outward_scan_required", (r) =>
    r.direction !== "OUT"
    || r.entry_method === "scan"
    || COUNTED.includes(r.item_kind as string)
    || (r.exception_reason != null && r.photo_path != null)],
  ["gate_scans_manual_needs_photo", (r) =>
    r.entry_method !== "manual" || r.photo_path != null],
  ["gate_scans_override_needs_proof", (r) =>
    r.override_reason == null || r.photo_path != null],
];

const checkViolation = (row: Record<string, unknown>) => {
  const hit = CHECKS.find(([, ok]) => !ok(row));
  return hit
    ? { error: { code: "23514", message:
        `new row for relation "gate_scans" violates check constraint "${hit[0]}"` },
        data: null }
    : null;
};

/**
 * Stub Postgres. Enforces the two unique constraints that carry the design —
 * client ids, and one barcode per trip — because those are precisely what the
 * replay behaviour depends on, plus the CHECK constraints above.
 */
function stubDb(opts: { existingTrips?: Record<string, string> } = {}) {
  const tripsByClient = new Map<string, string>(Object.entries(opts.existingTrips ?? {}));
  const tripRows = new Map<string, Record<string, unknown>>();
  const scanRows: Record<string, unknown>[] = [];
  const scanIds = new Set<string>();
  const perTripBarcodes = new Set<string>();
  const updates: Record<string, unknown>[] = [];
  const voidUpdates: Record<string, unknown>[] = [];
  const rejections: Record<string, unknown>[] = [];
  let n = 0;

  const dup = { error: { code: "23505", message: "duplicate key" }, data: null };

  const db = {
    from(table: string) {
      if (table === "gate_trips") {
        return {
          insert(row: Record<string, unknown>) {
            const cid = row.client_trip_id as string;
            return {
              select: () => ({
                maybeSingle: async () => {
                  if (tripsByClient.has(cid)) return dup;
                  const id = `trip-${++n}`;
                  tripsByClient.set(cid, id);
                  tripRows.set(id, row);
                  return { data: { id }, error: null };
                },
                single: async () => ({ data: { id: `trip-${++n}` }, error: null }),
              }),
            };
          },
          select: () => ({
            eq(col: string, val: string) {
              const self = {
                eq: () => self,
                maybeSingle: async () => {
                  if (col === "client_trip_id") {
                    const id = tripsByClient.get(val);
                    return id ? { data: { id, direction: (tripRows.get(id)?.direction) ?? "OUT" }, error: null }
                              : { data: null, error: null };
                  }
                  const row = tripRows.get(val);
                  return { data: row ? { direction: row.direction, business_date: row.business_date, recorded_late: row.recorded_late ?? false } : { direction: "OUT", business_date: "2026-08-21" }, error: null };
                },
              };
              return self;
            },
          }),
          update(u: Record<string, unknown>) {
            updates.push(u);
            const self = { eq: () => self, is: () => self, then: (r: (v: unknown) => void) => r({ error: null }) };
            return self;
          },
        };
      }
      // The refusal log (0033). Captured so a test can assert that a rejection
      // was WRITTEN DOWN rather than merely handed back to the phone.
      if (table === "gate_sync_rejections") {
        return {
          insert: async (r: Record<string, unknown>[]) => {
            rejections.push(...r);
            return { error: null };
          },
        };
      }
      // gate_scans
      return {
        update(u: Record<string, unknown>) {
          // Mirrors PostgREST: .update().eq().eq().select() resolves to the
          // rows it touched, and an empty array when it matched nothing.
          const filters: Record<string, string> = {};
          const self = {
            eq(col: string, val: string) { filters[col] = val; return self; },
            select: async () => {
              const hit = scanRows.filter((r) =>
                Object.entries(filters).every(([c, v]) => r[c] === v) &&
                r.status !== "void");
              for (const r of hit) Object.assign(r, u);
              voidUpdates.push({ ...u, matched: hit.length });
              return { data: hit.map((_, i) => ({ id: `scan-${i + 1}` })), error: null };
            },
          };
          return self;
        },
        insert(row: Record<string, unknown>) {
          return {
            select: () => ({
              maybeSingle: async () => {
                const cid = row.client_scan_id as string;
                const bcKey = `${row.trip_id}|${row.barcode}`;
                if (scanIds.has(cid)) return dup;
                if (row.barcode && perTripBarcodes.has(bcKey)) return dup;
                const bad = checkViolation(row);
                if (bad) return bad;
                scanIds.add(cid);
                if (row.barcode) perTripBarcodes.add(bcKey);
                scanRows.push(row);
                return { data: { id: `scan-${scanRows.length}` }, error: null };
              },
            }),
          };
        },
      };
    },
  };
  return { db: db as never, scanRows, tripRows, updates, voidUpdates, rejections };
}

describe("applyBatch — replay safety", () => {
  it("stores a trip and its scans", async () => {
    const { db, scanRows } = stubDb();
    const r = await applyBatch(db, WHO, { trips: [trip()], scans: [scan()] });
    expect(r.trips[0].status).toBe("stored");
    expect(r.scans[0].status).toBe("stored");
    expect(scanRows).toHaveLength(1);
  });

  // ── Recorded for yesterday (0044) ────────────────────────────────────────
  // A guard may choose yesterday for a truck that went unrecorded, and nothing
  // earlier. The items count on that day and are marked late; the real scan
  // times stay as they were.
  it("a trip recorded for yesterday counts on yesterday and is marked late — and so are its scans", async () => {
    const { db, scanRows, tripRows } = stubDb();
    // Opened 14 Sep 10:00 IST, for 13 Sep.
    const r = await applyBatch(db, WHO, {
      trips: [trip({ openedAt: "2026-09-14T04:30:00Z", movementDate: "2026-09-13" })],
      scans: [scan({ scannedAt: "2026-09-14T04:31:00Z" })],
    }, new Date("2026-09-14T04:32:00Z"));
    expect(r.trips[0].status).toBe("stored");
    const t = [...tripRows.values()][0];
    expect(t).toMatchObject({ business_date: "2026-09-13", movement_date: "2026-09-13", recorded_late: true });
    expect(scanRows[0]).toMatchObject({ business_date: "2026-09-13", recorded_late: true, scanned_at: "2026-09-14T04:31:00Z" });
  });

  it("any date other than the day before is ignored — recorded on its own day, never lost", async () => {
    const { db, tripRows, scanRows } = stubDb();
    const r = await applyBatch(db, WHO, {
      trips: [trip({ openedAt: "2026-09-14T04:30:00Z", movementDate: "2026-09-10" })],
      scans: [scan({ scannedAt: "2026-09-14T04:31:00Z" })],
    }, new Date("2026-09-14T04:32:00Z"));
    expect(r.trips[0].status).toBe("stored");
    const t = [...tripRows.values()][0];
    expect(t.recorded_late).toBeUndefined();
    expect(t.business_date).not.toBe("2026-09-10");
    expect(scanRows[0].recorded_late).toBeUndefined();
  });

  // ── The vehicle photo (0045) ─────────────────────────────────────────────
  it("a trip carrying a vehicle photo is pointed at it and handed an upload link", async () => {
    const { db, tripRows } = stubDb();
    const r = await applyBatch(db, WHO, { trips: [trip({ hasVehiclePhoto: true })] });
    expect(r.trips[0]).toMatchObject({ status: "stored", photoUploadPath: expect.stringMatching(/vehicle-ct-1\.jpg$/) });
    expect([...tripRows.values()][0].vehicle_photo_path).toMatch(/vehicle-ct-1\.jpg$/);
  });

  it("the close of a trip already stored still gets the photo's link — that is the normal path", async () => {
    const { db, updates } = stubDb({ existingTrips: { "ct-1": "trip-existing" } });
    const r = await applyBatch(db, WHO, { trips: [trip({ status: "closed", closedAt: "2026-08-21T11:00:00Z", hasVehiclePhoto: true })] });
    expect(r.trips[0]).toMatchObject({ status: "duplicate", photoUploadPath: expect.stringMatching(/vehicle-ct-1\.jpg$/) });
    expect(updates.some((u) => typeof u.vehicle_photo_path === "string")).toBe(true);
  });

  it("a trip without one asks for nothing", async () => {
    const { db } = stubDb();
    const r = await applyBatch(db, WHO, { trips: [trip()] });
    expect((r.trips[0] as { photoUploadPath?: string }).photoUploadPath).toBeUndefined();
  });

  it("re-sending the SAME batch books nothing twice", async () => {
    const { db, scanRows } = stubDb();
    await applyBatch(db, WHO, { trips: [trip()], scans: [scan()] });
    const again = await applyBatch(db, WHO, { trips: [trip()], scans: [scan()] });
    expect(again.trips[0].status).toBe("duplicate");
    expect(again.scans[0].status).toBe("duplicate");
    // The only assertion that really matters in this file.
    expect(scanRows).toHaveLength(1);
  });

  it("still resolves scans when their trip is a replay", async () => {
    // The phone opened the trip in an earlier batch that DID land, then lost the
    // response. It re-sends trip + scans together. The scans are new and must
    // attach to the trip already stored, not be orphaned.
    const { db, scanRows } = stubDb({ existingTrips: { "ct-1": "trip-existing" } });
    const r = await applyBatch(db, WHO, { trips: [trip()], scans: [scan({ clientScanId: "cs-new" })] });
    expect(r.trips[0].status).toBe("duplicate");
    expect(r.scans[0].status).toBe("stored");
    expect(scanRows[0].trip_id).toBe("trip-existing");
  });

  it("applies a close that arrives after the trip was already stored", async () => {
    const { db, updates } = stubDb({ existingTrips: { "ct-1": "trip-existing" } });
    await applyBatch(db, WHO, {
      trips: [trip({ status: "closed", closedAt: "2026-08-21T11:00:00Z" })],
    });
    expect(updates.some((u) => u.status === "closed")).toBe(true);
  });

  it("refuses the same barcode twice on one trip", async () => {
    const { db, scanRows } = stubDb();
    const r = await applyBatch(db, WHO, {
      trips: [trip()],
      scans: [scan({ clientScanId: "a" }), scan({ clientScanId: "b" })],
    });
    expect(r.scans[0].status).toBe("stored");
    expect(r.scans[1].status).toBe("duplicate");
    expect(scanRows).toHaveLength(1);
  });

  it("keeps going after a bad row instead of failing the batch", async () => {
    const { db } = stubDb();
    const r = await applyBatch(db, WHO, {
      trips: [trip()],
      scans: [
        scan({ clientScanId: "ok-1" }),
        scan({ clientScanId: "bad", barcode: null, entryMethod: "scan" }),
        scan({ clientScanId: "ok-2", barcode: "APC7VY25040463" }),
      ],
    });
    expect(r.scans.map((s) => s.status)).toEqual(["stored", "rejected", "stored"]);
  });
});

describe("applyBatch — the server decides, not the phone", () => {
  it("derives the business day from the instant, not the calendar date", async () => {
    const { db, scanRows } = stubDb();
    await applyBatch(db, WHO, {
      trips: [trip({ openedAt: "2026-08-21T04:30:00Z" })],
      scans: [scan({ scannedAt: "2026-08-21T04:30:00Z" })],
    });
    // 10:00 IST on the 21st is still business day the 20th.
    expect(scanRows[0].business_date).toBe("2026-08-20");
  });

  it("stamps city and site from the device, ignoring anything sent", async () => {
    const { db, scanRows } = stubDb();
    await applyBatch(db, WHO, { trips: [trip()], scans: [scan()] });
    expect(scanRows[0].city).toBe("DELHI");
    expect(scanRows[0].site_code).toBe("GUR");
  });

  it("stores the barcode exactly as scanned, never folded", async () => {
    const { db, scanRows } = stubDb();
    await applyBatch(db, WHO, { trips: [trip()], scans: [scan({ barcode: "FUL5ZA24120009" })] });
    // The Z must survive. Folded it becomes FUL52A24120009, which matches
    // nothing in Odoo — the exact bug this whole project removes.
    expect(scanRows[0].barcode).toBe("FUL5ZA24120009");
  });

  it("uppercases the vehicle registration", async () => {
    const { db, tripRows } = stubDb();
    await applyBatch(db, WHO, { trips: [trip({ vehicleNo: "hr26 dk 8337" })] });
    expect([...tripRows.values()][0].vehicle_no).toBe("HR26 DK 8337");
  });
});

describe("applyBatch — the control rules", () => {
  it("rejects a trip with no vehicle", async () => {
    const { db } = stubDb();
    const r = await applyBatch(db, WHO, { trips: [trip({ vehicleNo: "  " })] });
    expect(r.trips[0].status).toBe("rejected");
  });

  it("requires a photo on a manual entry", async () => {
    const { db } = stubDb();
    const r = await applyBatch(db, WHO, {
      trips: [trip()],
      scans: [scan({ entryMethod: "manual", barcode: null, itemKind: "consumable", hasPhoto: false })],
    });
    expect(r.scans[0].status).toBe("rejected");
  });

  it("requires a photo on an override", async () => {
    const { db } = stubDb();
    const r = await applyBatch(db, WHO, {
      trips: [trip()],
      scans: [scan({ overrideReason: "added late", hasPhoto: false })],
    });
    expect(r.scans[0].status).toBe("rejected");
  });

  it("lets a counted item through with NO identifier at all", async () => {
    // The bug this pins: an earlier rule demanded a serial on every row, which
    // made a box of consumables impossible to record. There is no serial, there
    // never was, and the quantity is the whole fact.
    const { db, scanRows } = stubDb();
    const r = await applyBatch(db, WHO, {
      trips: [trip()],
      scans: [scan({ barcode: null, entryMethod: "manual", itemKind: "consumable",
                     quantity: 12, hasPhoto: true })],
    });
    expect(r.scans[0].status).toBe("stored");
    expect(scanRows[0].quantity).toBe(12);
    expect(scanRows[0].barcode).toBeNull();
  });

  // ── The outward manual entries that never existed ──────────────────────
  //
  // Reported 11 Sep 2026: items added by hand to an outward trip do not appear
  // in the register. Measured: two refused that day at Delhi (12:45 spare part,
  // 12:59 consumable, both with photos), one manual entry stored in the whole
  // of history, and it inward. The database demanded exception_reason on any
  // outward non-scan; nothing in the app has ever set it.
  //
  // The suite already CLAIMED this worked — "lets a counted item through with
  // NO identifier at all" runs a consumable through an outward trip and expects
  // it stored. It passed while production refused the same row, because the
  // stub knew about unique constraints and not CHECK ones. That gap is closed
  // above; these pin the behaviour itself.

  for (const kind of ["spare_part", "consumable", "pp_box", "sample"] as const) {
    it(`stores a ${kind} added by hand to an outward trip`, async () => {
      const { db, scanRows } = stubDb();
      const r = await applyBatch(db, WHO, {
        trips: [trip({ direction: "OUT" })],
        scans: [scan({ barcode: null, entryMethod: "manual", itemKind: kind,
                       hasPhoto: true })],
      });
      expect(r.scans[0].status).toBe("stored");
      // No reason invented on its way in. The row is honest about being a
      // hand-entered count with a photograph behind it, which is all it is.
      expect(scanRows[0].exception_reason).toBeNull();
      expect(scanRows[0].photo_path).toBeTruthy();
    });
  }

  it("still refuses an identified item leaving by hand with no reason", async () => {
    // What 0023 was actually written about: a unit whose sticker was destroyed.
    // The escape hatch stays expensive.
    const { db, scanRows } = stubDb();
    const r = await applyBatch(db, WHO, {
      trips: [trip({ direction: "OUT" })],
      scans: [scan({ barcode: "FUL5ZA24120009", entryMethod: "manual",
                     itemKind: "unit", hasPhoto: true })],
    });
    expect(r.scans[0].status).toBe("rejected");
    // Refused in words, BEFORE the database — so the guard reads a sentence
    // rather than the constraint that produced it.
    expect(r.scans[0]).toMatchObject({ reason: expect.stringMatching(/stated reason/i) });
    expect(scanRows).toHaveLength(0);
  });

  it("lets an identified item leave by hand when it says why", async () => {
    const { db, scanRows } = stubDb();
    const r = await applyBatch(db, WHO, {
      trips: [trip({ direction: "OUT" })],
      scans: [scan({ barcode: "FUL5ZA24120009", entryMethod: "manual",
                     itemKind: "unit", hasPhoto: true,
                     exceptionReason: "sticker torn off in the van" })],
    });
    expect(r.scans[0].status).toBe("stored");
    expect(scanRows[0].exception_reason).toBe("sticker torn off in the van");
  });

  it("will not let vendor goods leave", async () => {
    const { db } = stubDb();
    const r = await applyBatch(db, WHO, {
      trips: [trip({ direction: "OUT" })],
      scans: [scan({ itemKind: "vendor_goods", barcode: null, entryMethod: "manual", hasPhoto: true, serialNo: "SN-9" })],
    });
    expect(r.scans[0].status).toBe("rejected");
  });

  it("flags an untagged customer return as an exception on its own", async () => {
    const { db, scanRows } = stubDb();
    await applyBatch(db, WHO, {
      trips: [trip({ direction: "IN" })],
      scans: [scan({ itemKind: "customer_return", barcode: null, entryMethod: "manual",
                     hasPhoto: true, soNumber: "ON-RET-GUR-74393" })],
    });
    // Nothing in the payload said "exception" — the server concluded it.
    expect(scanRows[0].exception_reason).toMatch(/sticker/i);
    expect(scanRows[0].barcode_pending).toBe(true);
  });

  it("holds a tagged unit to a quantity of one", async () => {
    const { db } = stubDb();
    const r = await applyBatch(db, WHO, {
      trips: [trip()], scans: [scan({ quantity: 4 })],
    });
    expect(r.scans[0].status).toBe("rejected");
  });
});


// ── Retractions ──────────────────────────────────────────────────────────
// A guard scans the wrong box and takes it back. Before this existed the only
// options were leaving a wrong row in the record or abandoning the trip, and
// the first is what actually happened — which is how a digital register starts
// lying in exactly the way the paper one did.
//
// The row is never deleted. It is marked void with a reason, and the reconcile
// connector reads status='recorded' only, so it stops counting the moment this
// lands while the trail still shows it was corrected rather than that it never
// existed.

const voidOf = (o: Partial<InVoid> = {}): InVoid => ({
  clientScanId: "cs-1", reason: "removed by the guard during the trip",
  voidedAt: "2026-08-21T10:35:00Z", ...o,
});

describe("applyBatch — retracting a scan", () => {
  it("marks the scan void, with its reason and who did it", async () => {
    const { db, scanRows, voidUpdates } = stubDb();
    await applyBatch(db, WHO, { trips: [trip()], scans: [scan()] });
    const r = await applyBatch(db, WHO, { voids: [voidOf()] });

    expect(r.voids[0].status).toBe("stored");
    expect(scanRows[0].status).toBe("void");
    expect(scanRows[0].void_reason).toBe("removed by the guard during the trip");
    expect(scanRows[0].voided_by).toBe("guard-1");
    // The movement is still THERE. A source of truth that can erase its own
    // history is not one.
    expect(scanRows).toHaveLength(1);
    expect(voidUpdates[0].matched).toBe(1);
  });

  it("applies scans BEFORE voids inside one batch", async () => {
    // A phone offline for an hour can hold both the scan and its retraction.
    // Applying the void first would leave the scan behind it as a live row —
    // the exact double-count this is meant to prevent.
    const { db, scanRows } = stubDb();
    await applyBatch(db, WHO, {
      trips: [trip()], scans: [scan()], voids: [voidOf()],
    });
    expect(scanRows[0].status).toBe("void");
  });

  it("cannot reach across cities", async () => {
    // The city comes from the DEVICE, so a phone at one gate cannot retract a
    // movement recorded at another — the mistake a client-supplied identifier
    // invites on day one.
    const { db, scanRows } = stubDb();
    await applyBatch(db, WHO, { trips: [trip()], scans: [scan()] });
    const other: GateIdentity = { ...WHO, city: "MUMBAI" };
    const r = await applyBatch(db, other, { voids: [voidOf()] });

    expect(scanRows[0].status).not.toBe("void");
    // Nothing matched, which from the phone's side is "already dealt with" —
    // a retraction it retries forever is a queue that never drains.
    expect(r.voids[0].status).toBe("duplicate");
  });

  it("treats a replayed void as a duplicate rather than an error", async () => {
    const { db } = stubDb();
    await applyBatch(db, WHO, { trips: [trip()], scans: [scan()] });
    await applyBatch(db, WHO, { voids: [voidOf()] });
    const again = await applyBatch(db, WHO, { voids: [voidOf()] });
    expect(again.voids[0].status).toBe("duplicate");
  });

  it("refuses a retraction with no reason", async () => {
    // The schema requires it too (gate_scans_void_has_reason), but an
    // unexplained disappearance should never get as far as the database.
    const { db } = stubDb();
    await applyBatch(db, WHO, { trips: [trip()], scans: [scan()] });
    const r = await applyBatch(db, WHO, { voids: [voidOf({ reason: "  " })] });
    expect(r.voids[0].status).toBe("rejected");
  });

  it("a void for a scan the server never saw is not an error", async () => {
    // The phone removed something that had not synced yet and queued the void
    // anyway, or the batch arrived out of order. Either way the phone's wish is
    // granted and the queue must drain.
    const { db } = stubDb();
    const r = await applyBatch(db, WHO, { voids: [voidOf({ clientScanId: "never-existed" })] });
    expect(r.voids[0].status).toBe("duplicate");
  });
});


// ── The completeness result ──────────────────────────────────────────────
// A gap the phone found and the server dropped is worse than no check at all:
// the guard was told, believed it was recorded, and nothing was. The path that
// matters is the UPDATE, not the insert — a trip is opened in one batch and
// closed in a later one, so a close that forgot these columns would have
// recorded the gap precisely never.

const gap = (o: Partial<InCompleteness> = {}): InCompleteness => ({
  expectedTotal: 9, expectedScanned: 3,
  missing: ["B3", "B4", "B5", "B6", "B7", "B8"],
  unplannedCount: 1, warned: false, listAgeS: 42, ...o,
});

describe("applyBatch — recording what the completeness check found", () => {
  it("writes the gap when the trip is CLOSED in a later batch", async () => {
    const { db, updates } = stubDb();
    await applyBatch(db, WHO, { trips: [trip()] });          // opened
    await applyBatch(db, WHO, {                                // ...closed later
      trips: [trip({ status: "closed", closedAt: "2026-08-21T11:00:00Z", completeness: gap() })],
    });

    const close = updates.find((u) => u.status === "closed");
    expect(close, "the close never happened").toBeTruthy();
    expect(close!.expected_total).toBe(9);
    expect(close!.expected_scanned).toBe(3);
    expect(close!.expected_missing).toHaveLength(6);
    expect(close!.unplanned_count).toBe(1);
    expect(close!.expected_checked_at).toBeTruthy();
  });

  it("keeps 'was the guard warned' as sent, not inferred", async () => {
    // Through the silent period this is false on every trip. If the server
    // guessed it from the presence of a gap, the false-alarm rate would be
    // measured against guards who were shown nothing.
    const { db, updates } = stubDb();
    await applyBatch(db, WHO, { trips: [trip()] });
    await applyBatch(db, WHO, {
      trips: [trip({ status: "closed", closedAt: "2026-08-21T11:00:00Z",
                     completeness: gap({ warned: false }) })],
    });
    expect(updates.find((u) => u.status === "closed")!.expected_warned).toBe(false);
  });

  it("clamps a scanned count above the planned total", async () => {
    // The phone computes this and a phone is the least trustworthy thing in
    // the system. Left alone it would violate the CHECK constraint and reject
    // an otherwise good trip close — far worse than a slightly wrong statistic.
    const { db, updates } = stubDb();
    await applyBatch(db, WHO, { trips: [trip()] });
    await applyBatch(db, WHO, {
      trips: [trip({ status: "closed", closedAt: "2026-08-21T11:00:00Z",
                     completeness: gap({ expectedTotal: 2, expectedScanned: 99 }) })],
    });
    const close = updates.find((u) => u.status === "closed")!;
    expect(close.expected_scanned).toBe(2);
    expect(close.expected_total).toBe(2);
  });

  it("leaves the columns alone when the phone sent no result", async () => {
    // An older app version, or a trip closed offline before the list arrived.
    // Writing zeroes would look like "nothing was planned" rather than
    // "nobody checked", and the weekly view counts on telling those apart.
    const { db, updates } = stubDb();
    await applyBatch(db, WHO, { trips: [trip()] });
    await applyBatch(db, WHO, {
      trips: [trip({ status: "closed", closedAt: "2026-08-21T11:00:00Z" })],
    });
    const close = updates.find((u) => u.status === "closed")!;
    expect(close.expected_checked_at).toBeUndefined();
    expect(close.expected_total).toBeUndefined();
  });
});

// ── Refusals are written down ────────────────────────────────────────────
// A guard added manual items, they never appeared, and the only record of why
// lived in IndexedDB on a phone at a gate. Returning the reason to the device
// is correct and is also a dead end: nobody else can open that device.

describe("applyBatch — a refusal is answerable by somebody else", () => {
  it("logs the reason, the guard and enough to recognise the item", async () => {
    const { db, rejections } = stubDb();
    await applyBatch(db, WHO, { trips: [trip()] });
    // A manual entry with no photograph — the commonest real refusal.
    await applyBatch(db, WHO, {
      scans: [scan({ clientScanId: "cs-9", entryMethod: "manual", barcode: null,
                     serialNo: "SP-1", itemKind: "spare_part", hasPhoto: false })],
    });

    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({
      client_id: "cs-9", kind: "scan", city: "DELHI", guard_id: "guard-1",
    });
    expect(String(rejections[0].reason)).toMatch(/photo/i);
    // Enough to identify the item, never a shadow copy of a row we declined
    // to store.
    expect(rejections[0].summary).toMatchObject({
      serialNo: "SP-1", itemKind: "spare_part", entryMethod: "manual", hasPhoto: false,
    });
  });

  it("says nothing when everything was accepted", async () => {
    const { db, rejections } = stubDb();
    await applyBatch(db, WHO, { trips: [trip()], scans: [scan()] });
    expect(rejections).toEqual([]);
  });

  it("never fails the batch when the log itself is unwritable", async () => {
    // The movements are the point; this is the note. A problem writing the note
    // must not lose a movement that was already accepted.
    const { db, scanRows } = stubDb();
    const inner = db as unknown as { from: (x: string) => unknown };
    const broken = {
      from(t: string) {
        if (t === "gate_sync_rejections") throw new Error("table missing");
        return inner.from(t);
      },
    } as never;
    await applyBatch(broken, WHO, { trips: [trip()] });
    const r = await applyBatch(broken, WHO, { scans: [scan()] });
    expect(r.scans[0].status).toBe("stored");
    expect(scanRows).toHaveLength(1);
  });
});

// ── A queue that cannot drain ────────────────────────────────────────────
// REPORTED FROM A REAL PHONE, 26 Aug: "it is not sending the data". Four trips
// queued BEFORE the delivery agent became mandatory arrived after migration
// 0030 added the constraint. Each was refused, 31 times. And a refused trip
// orphans everything belonging to it — three scans and a photographed manual
// entry were stuck behind trips that could never be accepted.
//
// Refusing a movement to protect a data-quality rule is the wrong trade. It is
// the same error as reading silence as zero: the rule is preserved and the
// thing the rule exists to describe is lost.

describe("applyBatch — a trip with no agent still records", () => {
  it("accepts it rather than refusing it forever", async () => {
    const { db, tripRows } = stubDb();
    const r = await applyBatch(db, WHO, { trips: [trip({ driverName: null })] });
    expect(r.trips[0].status).toBe("stored");
    // Named in the field itself, so nobody reads it as a person and the gap is
    // greppable.
    const row = [...tripRows.values()][0];
    expect(row.driver_name).toBe("(not recorded)");
  });

  it("does not orphan the scans that belong to it", async () => {
    // The expensive half of the bug: the trip was one refusal, the scans were
    // silent casualties of it.
    const { db, scanRows } = stubDb();
    const r = await applyBatch(db, WHO, {
      trips: [trip({ driverName: null })],
      scans: [scan(), scan({ clientScanId: "cs-2", barcode: "FUMYHA23030062" })],
    });
    expect(r.scans.every((s) => s.status === "stored")).toBe(true);
    expect(scanRows).toHaveLength(2);
  });

  it("still prefers a real agent when one was given", async () => {
    const { db, tripRows } = stubDb();
    await applyBatch(db, WHO, { trips: [trip({ driverName: "  Sudhir Kumar " })] });
    expect([...tripRows.values()][0].driver_name).toBe("Sudhir Kumar");
  });
});

// A refusal is read by a guard in Settings and by whoever opens the Reviews
// tab. Neither can act on `new row for relation "gate_scans" violates check
// constraint "gate_scans_outward_scan_required"`, which is what both were shown
// for every manual outward entry the app produced.
describe("saying why the database refused a row", () => {
  it("turns a constraint into a sentence, keeping the name for an engineer", () => {
    const said = readableDbError(
      'new row for relation "gate_scans" violates check constraint "gate_scans_manual_needs_photo"'
    );
    expect(said).toBe("an item added by hand needs a photo (gate_scans_manual_needs_photo)");
  });

  it("leaves an unfamiliar refusal exactly as Postgres said it", () => {
    // A refusal nobody predicted is when the database's own words are worth
    // more than a tidy guess.
    const raw = 'null value in column "city" violates not-null constraint';
    expect(readableDbError(raw)).toBe(raw);
  });

  it("matches on the constraint name, not the sentence around it", () => {
    // A Postgres upgrade rewording its message must not drop us back to
    // showing that message.
    expect(readableDbError('... constraint "gate_trips_agent_named" ...'))
      .toMatch(/delivery agent/);
  });
});
