// applyBatch is where a phone that has been offline for four hours meets the
// database. The failure that matters most is not rejection — it is a REPLAY
// quietly booking the same movement twice, which invents stock leaving the
// building and is indistinguishable from a real second dispatch afterwards.

import { describe, expect, it } from "vitest";
import { applyBatch, type InCompleteness, type InScan, type InTrip,
         type InVoid } from "../../lib/gate/sync";
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
 * Stub Postgres. Enforces the two unique constraints that carry the design —
 * client ids, and one barcode per trip — because those are precisely what the
 * replay behaviour depends on.
 */
function stubDb(opts: { existingTrips?: Record<string, string> } = {}) {
  const tripsByClient = new Map<string, string>(Object.entries(opts.existingTrips ?? {}));
  const tripRows = new Map<string, Record<string, unknown>>();
  const scanRows: Record<string, unknown>[] = [];
  const scanIds = new Set<string>();
  const perTripBarcodes = new Set<string>();
  const updates: Record<string, unknown>[] = [];
  const voidUpdates: Record<string, unknown>[] = [];
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
                  return { data: row ? { direction: row.direction, business_date: row.business_date } : { direction: "OUT", business_date: "2026-08-21" }, error: null };
                },
              };
              return self;
            },
          }),
          update(u: Record<string, unknown>) {
            updates.push(u);
            const self = { eq: () => self, then: (r: (v: unknown) => void) => r({ error: null }) };
            return self;
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
  return { db: db as never, scanRows, tripRows, updates, voidUpdates };
}

describe("applyBatch — replay safety", () => {
  it("stores a trip and its scans", async () => {
    const { db, scanRows } = stubDb();
    const r = await applyBatch(db, WHO, { trips: [trip()], scans: [scan()] });
    expect(r.trips[0].status).toBe("stored");
    expect(r.scans[0].status).toBe("stored");
    expect(scanRows).toHaveLength(1);
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
