// What each of the four books counted for the day, in and out.
//
// WHY THIS EXISTS. The dashboard could tell you about one unit at a time and
// nothing at all about the day as a whole. The first question anybody asks of a
// reconciliation — "do the four counts even agree?" — took opening the digest
// email or querying run_city_stats by hand, while the engine had been computing
// and storing exactly these figures on every run since migration 0012.
//
// It replaced the three KPI tiles. Those tiles answered "how much is on my
// list", which the one-line strip above this now answers in a tenth of the
// height; this answers "did the four records of today's movements line up",
// which nothing answered.
//
// THE RULE THIS SCREEN EXISTS TO HONOUR. A source that did not report is never
// shown as a zero. A Metabase outage and a genuinely quiet gate both count 0,
// and reading the first as the second is how an outage becomes a day that looks
// clean. `reported` is carried separately for exactly this, and a source that
// did not report renders as "no data" with no numbers at all.

"use client";

import { Icon } from "@/components/icon";
import type { CityAgg, SourceCount } from "@/lib/hooks/use-dashboard-data";

/** The four books, in the order the warehouse meets them. */
const SOURCES = [
  {
    key: "gate" as const,
    label: "Gate register",
    hint: "What the guard recorded at the gate — the only source that was physically present when the goods crossed.",
  },
  {
    key: "sheet" as const,
    label: "Ops sheet",
    hint: "The warehouse team's own record of the day.",
  },
  {
    key: "dt" as const,
    label: "Delivery app",
    hint: "What the delivery agents' app recorded against their tasks.",
  },
  {
    key: "odoo" as const,
    label: "Odoo",
    hint: "Stock movements posted in Odoo for this date. Odoo is posted after the fact, so it is routinely the last to fill in.",
  },
];

interface Props {
  agg: CityAgg | null;
  /** City name, or "ALL". Only used to phrase the caption. */
  city: string;
  loading: boolean;
  /** The day these figures describe, for the caption. */
  businessDate?: string;
}

export default function SourceScoreboard({ agg, city, loading, businessDate }: Props) {
  const all = city === "ALL";
  const rows = SOURCES.map((s) => ({ ...s, count: agg?.sources?.[s.key] }));
  const silent = rows.filter((r) => r.count && !r.count.reported);
  // The spread across the sources that DID report, per direction. Two books
  // never match to the unit — each writes at a different moment — so the number
  // worth showing is the size of the disagreement, not whether one exists.
  // Across cities every row shows a figure (a gap only makes it partial), so
  // every row is comparable; on one city a source with no data has no number to
  // compare and must not drag the spread to look like a disagreement.
  const reporting = rows
    .map((r) => r.count)
    .filter((c): c is SourceCount => !!c && (c.reported || all));
  const spread = (dir: "in" | "out") => {
    if (reporting.length < 2) return null;
    const vals = reporting.map((c) => c[dir]);
    return Math.max(...vals) - Math.min(...vals);
  };
  const inSpread = spread("in");
  const outSpread = spread("out");

  return (
    <div className="card overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-surface-elevated flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-headline text-base text-text-primary">
          What each source counted{city === "ALL" ? " · all cities" : ` · ${city}`}
        </h3>
        <p className="text-xs text-text-muted">
          {businessDate ? (
            <>
              business date <b className="text-text-secondary">{businessDate}</b> · 3pm to 3pm
            </>
          ) : (
            "movements recorded for the day"
          )}
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="table-clean">
          <thead>
            <tr>
              <th className="min-w-[160px]">Source</th>
              <th className="text-right min-w-[90px]">Inward</th>
              <th className="text-right min-w-[90px]">Outward</th>
              <th className="text-right min-w-[90px]">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const c = r.count;
              // Three states, and they must not collapse into two: still
              // loading, did not report, and reported a figure (including a
              // real zero).
              const unread = loading || !c;
              // ALL CITIES sums five warehouses and asks every one of them to
              // have reported. Usually one has not — only Delhi is on the gate
              // app — and blanking the row there would hide 88 real outward
              // scans to report an absence in Mumbai. So across cities a gap
              // makes the total PARTIAL; on a single city it makes it unknown.
              const gap = !!c && !c.reported;
              const down = gap && !all;
              const partial = gap && all;
              return (
                <tr key={r.key} className={down ? "opacity-60" : undefined}>
                  <td>
                    <span className="text-text-primary font-medium" title={r.hint}>
                      {r.label}
                    </span>
                    {down && (
                      <span className="badge badge-suppressed uppercase ml-2" title="This source did not report for this city and day — a connector failure, a gate that never synced, or a sheet not filed yet. The blanks are unknown, not zero.">
                        No data
                      </span>
                    )}
                    {partial && (
                      <span className="badge badge-suppressed uppercase ml-2" title="At least one city has no figure from this source for this day, so the totals beside it cover only the cities that did report. Open a single city tab to see which.">
                        Partial
                      </span>
                    )}
                  </td>
                  <td className="text-right font-semibold text-text-primary">
                    {unread ? "…" : down ? "—" : c.in}
                  </td>
                  <td className="text-right font-semibold text-text-primary">
                    {unread ? "…" : down ? "—" : c.out}
                  </td>
                  <td className="text-right text-text-secondary">
                    {unread ? "…" : down ? "—" : c.in + c.out}
                    {partial && !unread && <span className="text-text-disabled">+</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="px-4 py-2.5 border-t border-border text-xs text-text-muted flex flex-wrap items-center gap-x-4 gap-y-1">
        {loading ? (
          "Loading…"
        ) : silent.length > 0 && !all ? (
          <span className="text-status-warning flex items-center gap-1.5">
            <Icon name="warning" size={14} />
            {silent.map((s) => s.label).join(", ")} did not report — this day cannot be judged
            complete
          </span>
        ) : silent.length > 0 ? (
          <span className="text-status-warning flex items-center gap-1.5">
            <Icon name="warning" size={14} />
            {silent.map((s) => s.label).join(", ")} is missing from at least one city, so those
            totals cover only the cities that reported. Open a city tab to see which.
          </span>
        ) : inSpread !== null && outSpread !== null ? (
          <span>
            Widest gap between the books: <b className="text-text-secondary">{inSpread} inward</b>,{" "}
            <b className="text-text-secondary">{outSpread} outward</b>. The four never match to the
            unit — each is written at a different moment — so the list below is where the real
            disagreements are named.
          </span>
        ) : (
          "Not enough sources reported to compare."
        )}
      </div>
    </div>
  );
}
