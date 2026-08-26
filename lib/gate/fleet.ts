// The vehicles and delivery agents scheduled at a gate today.
//
// WHY THIS EXISTS. A guard typed the truck number and the agent's name into two
// blank boxes at the start of every trip. Both are how a gate row is later
// matched to a planned movement, and both were free text on a phone keyboard
// held in one hand — "HR26DK8337", "HR 26 DK 8337", "hr26 dk 8337" and
// "HR26DK 8337" are one truck and four different strings. The same name comes
// back spelled three ways in a week. Offering the day's actual list turns a
// typing exercise into a tap, and the value that lands is the one the planning
// system already uses.
//
// READ THROUGH METABASE, NOT MONGO. The Delivery Tracker is registered as a
// Metabase database, and this project already holds a Metabase credential — so
// DT is reachable with nothing new provisioned and no production connection
// string leaving Vercel. An aggregation pipeline also cannot write, which is a
// property of the query language rather than a promise, and the right footing
// for reading somebody else's production database.
//
// LIVE, NOT SCHEDULED. Fetched when the guard opens the app and again on the
// way into the trip form. Plans change until the last minute: a truck swapped
// at 18:00 is the normal case, not the exception, and a list built at 07:00
// would send the guard back to typing exactly when it matters most.
//
// NEVER A WALL. Everything here degrades to an empty list, and an empty list
// means the app shows a plain text box — the behaviour it had before. DT being
// slow, unreachable or misconfigured must never be the reason a guard cannot
// record a truck that is physically at the gate.

import { runMongoPipeline, metabaseConfigured } from "../connectors/metabase";
import { normalizeCity } from "../connectors/types";
import type { City } from "../sample-data";

/** Which Metabase database is the Delivery Tracker. Overridable, because a
 *  Metabase instance can be rebuilt and the ids renumber. */
export const dtDatabaseId = (): number => Number(process.env.METABASE_DT_DB_ID ?? 6);

/** This sits on a path a guard waits on, so it is bounded. */
const TIMEOUT_MS = 8_000;

export interface Fleet {
  vehicles: string[];
  agents: string[];
  /** Where the list came from, so a silent empty is distinguishable from a
   *  genuine "nothing is scheduled". The app shows one and not the other. */
  source: "dt" | "unavailable";
}

export const EMPTY_FLEET: Fleet = { vehicles: [], agents: [], source: "unavailable" };

/**
 * An Indian registration found anywhere in a string, or nothing.
 *
 *   state code   two letters          DL, MH, KA, TS, HR
 *   RTO          one or two digits    1, 12, 03
 *   series       up to four, MIXED    LAH, TV, U, and L2AG — a digit inside
 *                                     the letters is real
 *   number       exactly four digits
 *
 * SEPARATORS ARE STRIPPED BEFORE MATCHING, and that is the whole trick. The
 * first version split on hyphens and took the last piece, which silently lost
 * 10 of 46 real transport references — 22% of the fleet simply absent from the
 * guard's list. The plate itself carries separators in some of them:
 *
 *   MT - T - DL-1L-AN9769      the plate is hyphenated internally
 *   Pidge KA 08A 3734          spaces inside the plate
 *   KT - B - HR-55-AQ 8878     both, and a vendor prefix
 *   Vayutransport KA14C5943    no separator between vendor and plate at all
 *
 * Any rule that treats a separator as a boundary loses these. Stripping first
 * and then searching finds the plate wherever it sits, and the LAST match is
 * taken because a vendor code sometimes looks plate-ish and always comes first.
 */
const PLATE_ANYWHERE = /[A-Z]{2}\d{1,2}[A-Z0-9]{0,4}\d{4}/g;
export const PLATE_RE = /^[A-Z]{2}\d{1,2}[A-Z0-9]{0,4}\d{4}$/;

function plateOrNull(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  let last: string | null = null;
  let m: RegExpExecArray | null;
  PLATE_ANYWHERE.lastIndex = 0;
  while ((m = PLATE_ANYWHERE.exec(s)) !== null) {
    last = m[0];
    // Advance by one rather than by the whole match, so an overlapping later
    // plate is still found.
    PLATE_ANYWHERE.lastIndex = m.index + 1;
  }
  return last;
}

/**
 * Pull the registration out of a DT transport reference.
 *
 * `transportId` is not a registration — it is a vendor code, a service code and
 * a plate run together, spaced however whoever typed it felt at the time. Real
 * values, all from one week:
 *
 *   TC-Intra-MH12TV6748        MT - T - DL-1L-AN9769
 *   Pidge KA 08A 3734          KT - B - HR-55-AQ 8878
 *   Vayutransport KA14C5943    TORIX 407 KA03AB7069
 */
export function vehicleFromTransportId(raw: unknown): string | null {
  return plateOrNull(String(raw ?? ""));
}

/** A one-off hired vehicle, typed by hand into DT. Same validation. */
export function vehicleFromAdhoc(raw: unknown): string | null {
  return plateOrNull(String(raw ?? ""));
}

/** Tidy a person's name without mangling it. Case is left alone: a guard
 *  reading a list recognises "Ramesh Kumar", not "RAMESH KUMAR". */
export function normalizeAgent(v: unknown): string | null {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  if (s.length < 2 || s.length > 60) return null;
  // Guard against a placeholder reaching a dropdown as though it were a person.
  if (/^(n\/?a|na|test|none|null|-+)$/i.test(s)) return null;
  return s;
}

/**
 * The window a gate cares about.
 *
 * NOT the 15:00→15:00 business day the reconciler uses. A guard on the evening
 * shift is loading tomorrow morning's trucks as often as today's, and a list
 * that ended at 15:00 would be empty for the half of the day when the gate is
 * busiest. So: from this morning to the end of tomorrow, in IST.
 */
export function fleetWindow(now: Date = new Date()): { from: Date; to: Date } {
  const IST = 5.5 * 3600_000;
  const ist = new Date(now.getTime() + IST);
  const midnight = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
  return {
    from: new Date(midnight - IST),
    to: new Date(midnight - IST + 2 * 86_400_000),
  };
}

/**
 * The pipeline. Kept separate so a test can assert its shape without a network.
 *
 * The city lives on the DELIVERY, not the trip, so it has to be joined — and
 * the join is by `$toObjectId` because DT stores the reference as a string
 * while the target `_id` is an ObjectId. A plain localField/foreignField lookup
 * silently matches nothing, which reads exactly like a quiet day.
 */
export function fleetPipeline(from: Date, to: Date): unknown[] {
  return [
    {
      $match: {
        scheduledDate: { $gte: { $date: from.toISOString() }, $lt: { $date: to.toISOString() } },
        softDelete: { $ne: true },
      },
    },
    {
      $lookup: {
        from: "deliveries",
        let: { d: { $toObjectId: "$deliveryId" } },
        pipeline: [{ $match: { $expr: { $eq: ["$_id", "$$d"] } } }, { $project: { city: 1 } }],
        as: "dv",
      },
    },
    { $unwind: { path: "$dv", preserveNullAndEmptyArrays: true } },
    // `doneBy` carries the ASSIGNED agent, not only a completed one — verified
    // against trips still sitting at "Pickup Pending". The `agents` collection
    // looked like the obvious source and is not: it holds a single stale row.
    { $project: { _id: 0, city: "$dv.city", transportId: 1, adhoc_vehicle: 1, doneBy: 1 } },
    { $limit: 5000 },
  ];
}

/**
 * Read today's and tomorrow's scheduled vehicles and agents for one city.
 *
 * Never throws. If DT is having a bad minute the app gets an empty list and a
 * text box, which is an inconvenience; a spinner at a gate with a truck waiting
 * is not.
 */
export async function fleetForCity(city: City, now: Date = new Date()): Promise<Fleet> {
  if (!metabaseConfigured()) return EMPTY_FLEET;

  const { from, to } = fleetWindow(now);
  try {
    const table = await runMongoPipeline(
      dtDatabaseId(), "trips", fleetPipeline(from, to), TIMEOUT_MS
    );

    const vehicles = new Set<string>();
    const agents = new Set<string>();
    for (const r of table.rows) {
      // City is filtered HERE rather than in the pipeline because DT's
      // spellings are not the engine's — Gurgaon and Noida are both DELHI, and
      // normalizeCity is the one place that knows it. Duplicating those rules
      // into a Mongo query is how the two quietly drift apart.
      if (normalizeCity(r.city) !== city) continue;
      const v = vehicleFromTransportId(r.transportId) ?? vehicleFromAdhoc(r.adhoc_vehicle);
      const a = normalizeAgent(r.doneBy);
      if (v) vehicles.add(v);
      if (a) agents.add(a);
    }

    return {
      vehicles: [...vehicles].sort(),
      agents: [...agents].sort((x, y) => x.localeCompare(y)),
      source: "dt",
    };
  } catch {
    // Unreachable, timed out, or the credential is stale. The guard gets a text
    // box and never learns any of that happened.
    return EMPTY_FLEET;
  }
}
