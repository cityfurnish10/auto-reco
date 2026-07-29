// What every tool needs to know about who is asking.
//
// `visibleCities` is NOT the security boundary — RLS is. It exists because RLS
// returns an EMPTY SET rather than an error, which is the single biggest
// hallucination vector in this feature: a Mumbai manager asking about Delhi
// gets `total: 0`, and a model told to report exactly what it found would
// answer "nothing is open in Delhi". True of what it can see; dangerously false
// in the world.
//
// So tools check the requested city against this list and return
// `city_not_visible` instead of a zero. Presentation, not enforcement — the
// cookie-bound client still does the enforcing, and would still return nothing
// if this check were removed.

import { CITIES, type City } from "../../sample-data";

export interface ToolContext {
  /** Cities this caller may ask about. All five for an admin. */
  visibleCities: string[];
  /** Oldest business date with per-system detail — from the data, not a constant. */
  detailHeldFrom: string | null;
  latestReconciled: string | null;
}

export function visibleCitiesFor(role: string, city: string | null): string[] {
  if (role === "admin") return [...CITIES];
  return city ? [city as City] : [];
}
