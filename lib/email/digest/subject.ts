import type { DigestData } from "./types";
import { fmtDateShort } from "./sections";

const cityName = (c: string) => c.charAt(0) + c.slice(1).toLowerCase();

/** Beyond this most clients elide the middle, which is where the cities are. */
const MAX_SUBJECT = 100;

/**
 * Subject line. Branches on the TIER-1 count — units we cannot place — because
 * that is the only number the owner acts on.
 *
 * The count sits in the first ~45 characters: Gmail on mobile truncates around
 * 40, and a subject whose number falls off the end is a subject that failed.
 */
export function digestSubject(data: DigestData): string {
  const date = fmtDateShort(data.date);
  const t1 = data.totals.tier1;

  const shortCities = data.cities.filter(
    (c) => c.register === "missing" || c.register === "failed"
  );
  const suffix = shortCities.length
    ? ` · no guard register: ${
        shortCities.length === 1
          ? cityName(shortCities[0].city)
          : `${shortCities.length} cities`
      }`
    : "";

  if (data.runIncomplete) {
    // An instruction, not a status. "figures may be stale" leaves the reader to
    // decide what to do about it; this does not.
    return `Stock check ${date} — the check did not finish, do not act on these figures`;
  }

  if (t1 === 0) {
    // "All accounted for" is BLOCKED while any live city is short a register.
    // That city ran on three sources, so its at-risk count is understated and
    // the clean headline would be a lie. Say what is actually known instead.
    if (shortCities.length) {
      return `Stock check ${date} — nothing found yet${suffix}`;
    }
    // With its denominator. "all units accounted for" is a slogan; "all 3,825
    // units accounted for" is a fact the reader can weigh.
    const moved = data.totals.movements;
    return moved > 0
      ? `Stock check ${date} — all ${moved.toLocaleString("en-IN")} units accounted for`
      : `Stock check ${date} — all units accounted for`;
  }

  const withRisk = data.cities.filter((c) => c.tier1 > 0);
  const named = withRisk.slice(0, t1 > 10 ? 2 : 3);
  const rest = withRisk.length - named.length;
  const restUnits = withRisk.slice(named.length).reduce((n, c) => n + c.tier1, 0);

  // "to confirm" is the mildest possible verb for "we do not know where these
  // are". Say the thing. The trend clause rides the same coverage gate as the
  // opening line, so it is absent whenever a live city was short a book.
  const verdict = data.dayTrend === "worst" ? ", worst rate this week"
    : data.dayTrend === "best" ? ", best rate this week"
    : "";
  const head = `Stock check ${date} — ${t1} ${t1 === 1 ? "unit" : "units"} we cannot place${verdict}: `;
  const build = (cities: typeof named, tail: boolean) => {
    const parts = cities.map((c) => `${cityName(c.city)} ${c.tier1}`);
    if (tail && rest > 0) parts.push(`${rest} other ${rest === 1 ? "city" : "cities"} ${restUnits}`);
    return head + parts.join(", ") + suffix;
  };

  // Shed detail from the least useful end until it fits. The missing-register
  // suffix is never dropped: it changes how every number above it should be
  // read, which the "N other cities" tail does not.
  for (const candidate of [build(named, true), build(named, false), build(named.slice(0, 1), false)]) {
    if (candidate.length <= MAX_SUBJECT) return candidate;
  }
  return build(named.slice(0, 1), false);
}
