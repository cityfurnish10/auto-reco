// The vehicles and delivery agents scheduled at a gate today.
//
// WHY THIS EXISTS. A guard typed the truck number and the agent's name into
// two blank boxes at the start of every trip. Both are how a gate row is later
// matched to a planned movement, and both were free text on a phone keyboard
// held in one hand — "HR26DK8337", "HR 26 DK 8337", "hr26 dk 8337" and
// "HR26DK 8337" are one truck and four different strings. The same name comes
// back spelled three ways in a week. Offering the day's actual list turns a
// typing exercise into a tap, and the value that lands is the one the planning
// system already uses.
//
// LIVE, NOT SCHEDULED. Fetched when the guard opens the app and again when
// they close a trip, rather than by an overnight job. Plans change until the
// last minute: a truck swapped at 18:00 is the normal case, not the exception,
// and a list built at 07:00 would send the guard back to typing exactly when
// it matters most. Mongo is fast enough for a read on this path; Odoo, which
// goes through Metabase and takes seconds, deliberately is not on it.
//
// NEVER A WALL. Everything here degrades to an empty list, and an empty list
// means the app shows a plain text box — the behaviour it had before. DT being
// slow, unreachable or misconfigured must never be the reason a guard cannot
// record a truck that is physically at the gate.

import { MongoClient } from "mongodb";
import { normalizeCity } from "../connectors/types";
import type { City } from "../sample-data";

/**
 * Where the agent's name lives on a DT delivery, in preference order.
 *
 * ⚠ TO BE CONFIRMED against the live cluster. dt.ts notes that DB MODEL.md §18
 * joins `users` for an agent name it then drops, so the delivery almost
 * certainly carries either the name or a reference to it — but the exact key
 * has never been read by this codebase. Run `node scripts/dt-fields.mjs` with
 * DT_MONGODB_URI set and replace this list with the one field that is real.
 *
 * Written as a list rather than a single name on purpose: the first key that
 * holds a non-empty string wins, so a wrong guess costs nothing and the right
 * one starts working the moment it is added.
 */
const AGENT_FIELDS = [
  "agentName", "deliveryAgent", "agent_name", "driverName",
  "assignedToName", "deliveryAssociate", "executiveName",
] as const;

/** The vehicle registration, same caveat and same rule as above. */
const VEHICLE_FIELDS = [
  "vehicleNo", "vehicleNumber", "vehicle_no", "truckNumber",
  "vehicle", "vehicleRegNo",
] as const;

/** Mongo `$ifNull` chain over candidate keys — first non-null wins. */
function firstOf(fields: readonly string[]): unknown {
  return fields.reduceRight<unknown>(
    (fallback, f) => ({ $ifNull: [`$${f}`, fallback] }),
    null
  );
}

export interface Fleet {
  vehicles: string[];
  agents: string[];
  /** Where the list came from, so a silent empty is distinguishable from a
   *  genuine "nothing is scheduled". The app shows one and not the other. */
  source: "dt" | "unavailable";
}

export const EMPTY_FLEET: Fleet = { vehicles: [], agents: [], source: "unavailable" };

/** Tidy a registration into the one spelling the whole system agrees on. */
export function normalizeVehicle(v: unknown): string | null {
  const s = String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length >= 4 && s.length <= 14 ? s : null;
}

/** Tidy a person's name without mangling it. Case is left alone: a guard
 *  reading a list recognises "Ramesh Kumar", not "RAMESH KUMAR". */
export function normalizeAgent(v: unknown): string | null {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s.length >= 2 && s.length <= 60 ? s : null;
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
 * Read today's and tomorrow's scheduled vehicles and agents for one city.
 *
 * Bounded by a timeout because this sits on the path a guard waits on. If DT
 * is having a bad minute the app gets an empty list and a text box, which is
 * an inconvenience; a spinner at a gate with a truck waiting is not.
 */
export async function fleetForCity(city: City, now: Date = new Date(),
                                   timeoutMs = 4000): Promise<Fleet> {
  const uri = process.env.DT_MONGODB_URI;
  if (!uri) return EMPTY_FLEET;

  const dbName = process.env.DT_MONGODB_DB ?? "cityfurnish";
  const coll = process.env.DT_TASKS_COLLECTION ?? "deliveries";
  const { from, to } = fleetWindow(now);

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: timeoutMs,
    connectTimeoutMS: timeoutMs,
  });
  try {
    await client.connect();
    const rows = await client.db(dbName).collection(coll).aggregate([
      // scheduledDate is indexed; this is the cheap cut. Measured elsewhere in
      // this repo as a date marker pinned to 10:00 IST, which is exactly right
      // here — we want what is PLANNED, not what completed.
      { $match: { scheduledDate: { $gte: from, $lt: to } } },
      { $addFields: { _agent: firstOf(AGENT_FIELDS), _vehicle: firstOf(VEHICLE_FIELDS) } },
      { $match: { $or: [{ _agent: { $type: "string" } }, { _vehicle: { $type: "string" } }] } },
      { $project: { _id: 0, city: 1, _agent: 1, _vehicle: 1 } },
      // A gate list nobody can scroll is a text box with extra steps.
      { $limit: 4000 },
    ], { maxTimeMS: timeoutMs }).toArray();

    const vehicles = new Set<string>();
    const agents = new Set<string>();
    for (const r of rows) {
      // City is filtered HERE rather than in the $match because DT's spellings
      // are not the engine's — normalizeCity is the one place that knows the
      // difference, and duplicating its rules into a Mongo query is how the
      // two quietly drift apart.
      if (normalizeCity((r as Record<string, unknown>).city) !== city) continue;
      const v = normalizeVehicle((r as Record<string, unknown>)._vehicle);
      const a = normalizeAgent((r as Record<string, unknown>)._agent);
      if (v) vehicles.add(v);
      if (a) agents.add(a);
    }

    return {
      vehicles: [...vehicles].sort(),
      agents: [...agents].sort((x, y) => x.localeCompare(y)),
      source: "dt",
    };
  } catch {
    // Unreachable, timed out, or the credentials are stale. The guard gets a
    // text box and never learns any of that happened.
    return EMPTY_FLEET;
  } finally {
    await client.close().catch(() => {});
  }
}
