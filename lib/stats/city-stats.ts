// The one read of run_city_stats that the leaderboard and analytics share.
//
// WHY THIS FILE EXISTS, twice over.
//
// 1. BOTH ROUTES DECLARED StatRow AND ISSUED THE SAME QUERY, independently —
//    the same duplication accuracy.ts was written to remove one layer up. Two
//    copies that agree today are two copies that can disagree tomorrow, and
//    these two feed the same numbers to two screens.
//
// 2. NEITHER PAGED. PostgREST silently caps an un-ranged select at 1000 rows,
//    and both routes compute AGGREGATES from the result — so past the cap the
//    leaderboard and the charts would quietly start averaging a subset. At five
//    cities a day that is roughly 200 days of history: not a bug today (80 rows
//    at the time of writing), and a wrong number with no error message the day
//    it arrives. PostgREST does not promise an order on an un-ranged read
//    either, so the rows it dropped would not even be the oldest ones.
//
// The .order("business_date") before .range() is not cosmetic: an unordered
// page boundary can repeat or skip rows.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { StatRow } from "./accuracy";

const PAGE = 1000;
const COLUMNS = "business_date, city, movements, real_count, high_count";

/** Every run_city_stats row, paged. Throws on a read error, like its callers expect. */
export async function readCityStats(db: SupabaseClient): Promise<StatRow[]> {
  const out: StatRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("run_city_stats")
      .select(COLUMNS)
      // Deterministic across page boundaries; city breaks the date tie.
      .order("business_date", { ascending: true })
      .order("city", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as StatRow[];
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}
