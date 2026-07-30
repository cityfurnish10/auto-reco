"use client";

// How much stock each warehouse handled, over any range.
//
// Charts are hand-built divs — there is no charting library in this project and
// the technique is copied from app/(dashboard)/analytics/page.tsx: gridlines
// positioned by `bottom: %`, bars as divs with inline height and a
// var(--color-*) background, which is what makes them flip with the theme.
//
// TWO DEPARTURES from that file, both deliberate:
//   * the axis starts at ZERO. Its AXIS_MIN = 60 is defensible for accuracy
//     percentages clustered at 82-98%; for counts it is straightforwardly
//     misleading, because "twice as tall" has to mean "twice as many".
//   * bars are GROUPED, not stacked. The question is "is inward keeping up with
//     outward", which is a comparison of two series, and stacked segments do not
//     share a baseline.

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { DateRange, presetRange, DEFAULT_PRESETS, type DateRangeValue } from "@/components/date-range";
import { useStickyState } from "@/lib/hooks/use-sticky-state";

interface Bucket {
  key: string;
  date: string | null;
  city: string | null;
  ledgered: boolean;
  restDay: boolean;
  in: number | null;
  out: number | null;
  total: number | null;
  distinctUnits: number | null;
  bothDirections: number | null;
  clean: number | null;
  problems: number | null;
  backfilled: number | null;
  booksRead: number | null;
}

interface MovementsResponse {
  from: string;
  to: string;
  source: "ledger" | "rollup";
  scope: { cities: string[] };
  coverage: {
    firstLedgeredDate: string | null;
    firstPerSourceDate: string | null;
    firstRollupDate: string | null;
    unledgeredDates: string[];
    backfilledShare: number | null;
    ledgerCapDays: number;
  };
  buckets: Bucket[];
  totals: {
    in: number | null;
    out: number | null;
    total: number;
    distinctUnits: number | null;
    ledgerMovements: number | null;
    rollupMovements: number;
    drift: number | null;
  };
}

const nf = (n: number) => n.toLocaleString("en-IN");
const cityName = (c: string) => c.charAt(0) + c.slice(1).toLowerCase();
const dayLabel = (d: string) => `${Number(d.slice(8, 10))}/${d.slice(5, 7)}`;
const longDate = (d: string) =>
  new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });

/** The striped fill that makes IN readable without colour. */
const IN_FILL: React.CSSProperties = {
  backgroundColor: "var(--color-info-bg)",
  backgroundImage:
    "repeating-linear-gradient(45deg, var(--color-info-fg) 0 5px, transparent 5px 10px)",
};
const OUT_FILL: React.CSSProperties = { backgroundColor: "var(--color-accent)" };

export default function MovementVolumesPanel({ today }: { today: string }) {
  const [range, setRange] = useStickyState<DateRangeValue>(
    "stock.range",
    presetRange(DEFAULT_PRESETS[1], today)
  );
  const [data, setData] = useState<MovementsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const seq = useRef(0);

  /* eslint-disable react-hooks/set-state-in-effect -- setLoading toggles the
     async-fetch loading state; a synchronous set here is the pattern the rest of
     the dashboard already uses (lib/hooks/use-dashboard-data.ts). */
  useEffect(() => {
    if (range.from > range.to) return;
    const mine = ++seq.current;
    setLoading(true);
    setErr(null);
    const qs = new URLSearchParams({ from: range.from, to: range.to, groupBy: "day-city" });
    fetch(`/api/stock/movements?${qs}`, { credentials: "same-origin" })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        return j as MovementsResponse;
      })
      .then((j) => {
        if (mine !== seq.current) return; // a newer range superseded this one
        setData(j);
      })
      .catch((e) => {
        if (mine !== seq.current) return;
        setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
  }, [range.from, range.to]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Per-day totals across cities, on a CONTINUOUS date axis — the API returns only
  // days that produced rows, and a missing day must be drawn as a gap rather than
  // silently closing up.
  const days = useMemo(() => {
    if (!data) return [];
    const byDate = new Map<string, { in: number; out: number; ledgered: boolean; short: boolean; back: number }>();
    for (const b of data.buckets) {
      if (!b.date) continue;
      const a = byDate.get(b.date) ?? { in: 0, out: 0, ledgered: false, short: false, back: 0 };
      a.in += b.in ?? 0;
      a.out += b.out ?? 0;
      if (b.ledgered) a.ledgered = true;
      if (b.booksRead !== null && b.booksRead < 4) a.short = true;
      a.back += b.backfilled ?? 0;
      byDate.set(b.date, a);
    }
    const out: {
      date: string; in: number; out: number; total: number;
      ledgered: boolean; short: boolean; backfilled: boolean;
    }[] = [];
    for (let d = data.from; d <= data.to; ) {
      const a = byDate.get(d);
      out.push({
        date: d,
        in: a?.in ?? 0,
        out: a?.out ?? 0,
        total: (a?.in ?? 0) + (a?.out ?? 0),
        ledgered: a?.ledgered ?? false,
        short: a?.short ?? false,
        backfilled: (a?.back ?? 0) > 0,
      });
      const [y, m, dd] = d.split("-").map(Number);
      d = new Date(Date.UTC(y, m - 1, dd + 1)).toISOString().slice(0, 10);
    }
    return out;
  }, [data]);

  const byCity = useMemo(() => {
    if (!data) return [];
    const m = new Map<string, { in: number; out: number; rest: number }>();
    for (const b of data.buckets) {
      if (!b.city) continue;
      const a = m.get(b.city) ?? { in: 0, out: 0, rest: 0 };
      a.in += b.in ?? 0;
      a.out += b.out ?? 0;
      if (b.restDay) a.rest++;
      m.set(b.city, a);
    }
    return [...m.entries()]
      .map(([city, v]) => ({ city, ...v, total: v.in + v.out }))
      .sort((x, y) => y.total - x.total);
  }, [data]);

  const axisMax = useMemo(() => {
    const peak = Math.max(1, ...days.map((d) => Math.max(d.in, d.out)));
    const step = Math.pow(10, Math.max(0, String(Math.floor(peak)).length - 2));
    return Math.ceil(peak / step) * step;
  }, [days]);

  if (loading && !data) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-20 w-full rounded-card" />
        <Skeleton className="h-24 w-full rounded-card" />
        <Skeleton className="h-64 w-full rounded-card" />
      </div>
    );
  }
  if (err) {
    return (
      <div className="card p-4 bg-danger-soft border border-danger/20 text-sm text-danger font-semibold">
        We could not load the movement figures. {err}
      </div>
    );
  }
  if (!data) return null;

  const hasAny = days.some((d) => d.ledgered);
  const cov = data.coverage;

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
        <DateRange
          value={range}
          onChange={setRange}
          today={today}
          earliest={cov.firstRollupDate}
          legend="Date range"
        />
      </div>

      {/* The floors, before any number. Four different start dates, all from the
          API — hardcoding them would silently lie the day the data grows. */}
      <div className="card p-4 bg-info-soft border border-info/30 flex gap-3">
        <Icon name="info" size={18} className="text-info shrink-0 mt-0.5" />
        <div className="text-sm text-text-primary space-y-1">
          <p className="font-semibold">How far back these numbers go</p>
          <p className="text-text-secondary">
            {cov.firstRollupDate
              ? `Daily totals reach back to ${longDate(cov.firstRollupDate)}.`
              : "No daily totals have been recorded yet."}{" "}
            {cov.firstLedgeredDate
              ? `The in-and-out split starts on ${longDate(cov.firstLedgeredDate)} — days before that have a total only.`
              : "The in-and-out split has not started recording yet."}{" "}
            {cov.firstPerSourceDate
              ? `Which books were read is known from ${longDate(cov.firstPerSourceDate)}.`
              : ""}
            {cov.backfilledShare != null && cov.backfilledShare > 0
              ? ` About ${Math.round(cov.backfilledShare * 100)}% of the earliest unit records were reconstructed afterwards rather than written down on the night; those days are marked with an asterisk.`
              : ""}
          </p>
        </div>
      </div>

      {!hasAny ? (
        <EmptyState
          icon="inventory_2"
          title="No movement records in this range"
          detail={
            cov.firstRollupDate
              ? `Records start on ${longDate(cov.firstRollupDate)}. Choose a range that includes it.`
              : "Nothing has been recorded yet."
          }
        />
      ) : (
        <>
          {/* KPI row. Where the split does not cover the whole range, tiles 2 and 3
              name the sub-range they DO cover rather than folding a partial window
              into a full-window headline. */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-gutter">
            <div className="kpi-tile kpi-tile--accent">
              <div className="kpi-label">Units moved</div>
              <div className="kpi-value">{nf(data.totals.total)}</div>
              <div className="text-xs text-text-muted mt-1">
                {longDate(data.from)} – {longDate(data.to)}
              </div>
            </div>
            <div className="kpi-tile">
              <div className="kpi-label">Out — left the warehouse</div>
              <div className="kpi-value">{data.totals.out == null ? "—" : nf(data.totals.out)}</div>
              <div className="text-xs text-text-muted mt-1">
                {data.totals.out == null
                  ? "Not recorded for this range"
                  : cov.firstLedgeredDate
                    ? `From ${longDate(cov.firstLedgeredDate)}`
                    : ""}
              </div>
            </div>
            <div className="kpi-tile">
              <div className="kpi-label">In — came back</div>
              <div className="kpi-value">{data.totals.in == null ? "—" : nf(data.totals.in)}</div>
              <div className="text-xs text-text-muted mt-1">
                {data.totals.in == null
                  ? "Not recorded for this range"
                  : cov.firstLedgeredDate
                    ? `From ${longDate(cov.firstLedgeredDate)}`
                    : ""}
              </div>
            </div>
            <div className="kpi-tile kpi-tile--info">
              <div className="kpi-label">Units involved</div>
              <div className="kpi-value">
                {data.totals.distinctUnits == null ? "—" : nf(data.totals.distinctUnits)}
              </div>
              <div className="text-xs text-text-muted mt-1">
                {data.totals.distinctUnits == null
                  ? "Needs the unit records"
                  : "Counted once, however often they moved"}
              </div>
            </div>
          </div>

          {/* ── Chart A ─────────────────────────────────────────────────── */}
          <section className="card p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-headline text-lg text-text-primary">Movements per day</h2>
              <div className="flex flex-wrap items-center gap-4 text-xs">
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm" style={OUT_FILL} />
                  <Icon name="arrow_outward" size={12} className="text-text-muted" />
                  Out — left the warehouse (left bar)
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm" style={IN_FILL} />
                  <Icon name="arrow_back" size={12} className="text-text-muted" />
                  In — came back (right bar)
                </span>
              </div>
            </div>

            <div className="overflow-x-auto">
              <div className="relative pl-12" style={{ minWidth: days.length * 44 }}>
                <div className="relative h-64" role="img" aria-label={chartLabel(days, data)}>
                  {[1, 0.75, 0.5, 0.25, 0].map((f) => (
                    <div
                      key={f}
                      className="absolute inset-x-0 border-t border-border/70 flex items-center"
                      style={{ bottom: `${f * 100}%` }}
                    >
                      <span className="absolute -left-12 -translate-y-1/2 text-xs text-text-muted tabular-nums">
                        {nf(Math.round(axisMax * f))}
                      </span>
                    </div>
                  ))}
                  <div className="absolute inset-0 flex items-end gap-2">
                    {days.map((d, i) => (
                      <div
                        key={d.date}
                        // The whole column is the hover target, not the bar: a
                        // short bar is a few pixels tall, and the days worth
                        // asking about are often exactly the short ones.
                        className={
                          hover === i
                            ? "relative flex-1 flex flex-col items-center justify-end h-full min-w-[28px] bg-surface-elevated/60 rounded-t"
                            : "relative flex-1 flex flex-col items-center justify-end h-full min-w-[28px]"
                        }
                        onMouseEnter={() => setHover(i)}
                        onMouseLeave={() => setHover((h) => (h === i ? null : h))}
                      >
                        {hover === i ? <DayReadout d={d} /> : null}

                        {/* Always-on numerals at readable widths, so the figure
                            is not hostage to a hover the reader may not try. */}
                        {days.length <= 14 && d.ledgered && d.total > 0 ? (
                          <span className="text-[10px] text-text-muted tabular-nums leading-none mb-0.5">
                            {nf(d.total)}
                          </span>
                        ) : null}

                        {!d.ledgered ? (
                          // A day nobody checked. NEVER a zero-height bar: that
                          // reads as "nothing moved", which is a different claim.
                          <div className="w-full max-w-[34px] h-full rounded-t border border-dashed border-text-disabled/60 bg-surface-elevated/40 flex items-end justify-center pb-1">
                            <Icon name="close" size={12} className="text-text-disabled" />
                          </div>
                        ) : d.total === 0 ? (
                          <div className="w-full max-w-[34px] h-[2px] bg-text-disabled" />
                        ) : (
                          <div className="w-full max-w-[34px] flex items-end justify-center gap-[2px] h-full">
                            <div
                              className="flex-1 rounded-t"
                              style={{
                                ...OUT_FILL,
                                height: `${Math.max(2, (d.out / axisMax) * 100)}%`,
                                ...(d.short ? SHORT_CAP : {}),
                              }}
                            />
                            <div
                              className="flex-1 rounded-t"
                              style={{
                                ...IN_FILL,
                                height: `${Math.max(2, (d.in / axisMax) * 100)}%`,
                                ...(d.short ? SHORT_CAP : {}),
                              }}
                            />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="flex gap-2 mt-2">
                  {days.map((d) => (
                    <div
                      key={d.date}
                      className="flex-1 text-center text-xs text-text-muted tabular-nums min-w-[28px]"
                    >
                      {days.length <= 35 || d.date.endsWith("1") ? dayLabel(d.date) : ""}
                      {d.backfilled ? <span className="text-text-disabled">*</span> : null}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <p className="text-xs text-text-muted">
              Units moved per day. <strong>The axis starts at zero</strong>, so the bars are directly
              comparable. Left bar is out, right bar (striped) is in. A dashed column is a day nobody
              checked — that is not a day when nothing moved. A dashed cap means the day was counted
              from fewer than four books, so it is an undercount. An asterisk means the figures were
              reconstructed afterwards rather than recorded on the night.
            </p>

            {/* Tooltips are never the only source of a number. */}
            <details className="text-sm">
              <summary className="cursor-pointer text-text-secondary">
                Show these figures as a table
              </summary>
              <div className="overflow-x-auto mt-3">
                <table className="table-clean">
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col" className="text-right">Units moved</th>
                      <th scope="col" className="text-right">Out</th>
                      <th scope="col" className="text-right">In</th>
                      <th scope="col">How recorded</th>
                    </tr>
                  </thead>
                  <tbody>
                    {days.map((d) => (
                      <tr key={d.date}>
                        <td>{longDate(d.date)}</td>
                        <td className="text-right tabular-nums">{d.ledgered ? nf(d.total) : "—"}</td>
                        <td className="text-right tabular-nums">{d.ledgered ? nf(d.out) : "—"}</td>
                        <td className="text-right tabular-nums">{d.ledgered ? nf(d.in) : "—"}</td>
                        <td className="text-text-muted">
                          {!d.ledgered
                            ? "Not checked"
                            : d.backfilled
                              ? "Reconstructed later"
                              : "Recorded on the night"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </section>

          {/* ── Chart B ─────────────────────────────────────────────────── */}
          <section className="card p-6 space-y-4">
            <h2 className="font-headline text-lg text-text-primary">Warehouse comparison</h2>
            <div className="space-y-4">
              {byCity.map((c) => {
                const peak = Math.max(1, ...byCity.map((x) => Math.max(x.in, x.out)));
                return (
                  <div key={c.city} className="space-y-1.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm font-medium text-text-primary">
                        {cityName(c.city)}
                      </span>
                      <span className="text-sm text-text-secondary tabular-nums">
                        {nf(c.total)} units
                        {c.rest > 0 ? (
                          <span className="badge badge-suppressed ml-2">Closed {c.rest} days</span>
                        ) : null}
                      </span>
                    </div>
                    {c.total === 0 ? (
                      <p className="text-xs text-text-muted">No records for this range</p>
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-text-muted w-8">out</span>
                          <div className="flex-1 bg-surface-elevated rounded-pill h-2.5">
                            <div
                              className="h-2.5 rounded-pill"
                              style={{ ...OUT_FILL, width: `${(c.out / peak) * 100}%` }}
                            />
                          </div>
                          <span className="text-xs tabular-nums w-14 text-right">{nf(c.out)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-text-muted w-8">in</span>
                          <div className="flex-1 bg-surface-elevated rounded-pill h-2.5">
                            <div
                              className="h-2.5 rounded-pill"
                              style={{ ...IN_FILL, width: `${(c.in / peak) * 100}%` }}
                            />
                          </div>
                          <span className="text-xs tabular-nums w-14 text-right">{nf(c.in)}</span>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-text-muted">
              Total units in and out per warehouse over the chosen range. Mumbai, Pune and Hyderabad
              close one day a week, so over a range that spans one their total is lower for that
              reason alone. All bars share one scale, so a longer bar is genuinely more units.
            </p>
          </section>

          {data.totals.drift != null && data.totals.drift !== 0 ? (
            <p className="text-xs text-text-muted">
              Ledger {nf(data.totals.ledgerMovements ?? 0)} · latest check saw{" "}
              {nf(data.totals.rollupMovements)} ·{" "}
              {data.totals.drift > 0
                ? `${nf(data.totals.drift)} seen only by an earlier check`
                : `${nf(-data.totals.drift)} counted by the latest check but missing from the unit records`}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** A dashed cap reads as "at least this much". */
const SHORT_CAP: React.CSSProperties = {
  borderTop: "2px dashed var(--text-disabled)",
};

interface DayPoint {
  date: string;
  in: number;
  out: number;
  total: number;
  ledgered: boolean;
  short: boolean;
  backfilled: boolean;
}

/**
 * The figures for the hovered day.
 *
 * Pinned to the TOP of the chart area rather than floating above the bar, for
 * one boring reason: the scroll container is `overflow-x-auto`, which computes
 * overflow-y to `auto` as well, so anything drawn above the plot gets clipped.
 * Inside the box it is always readable, and it never moves as the bar height
 * changes.
 *
 * pointer-events-none so it cannot steal the hover from the column underneath
 * and flicker.
 */
function DayReadout({ d }: { d: DayPoint }) {
  return (
    <div className="absolute top-0 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
      <div className="bg-surface-card border border-border rounded-control shadow-card px-3 py-2 text-xs whitespace-nowrap">
        <div className="font-semibold text-text-primary">{longDate(d.date)}</div>
        {!d.ledgered ? (
          <div className="text-text-muted mt-0.5">No check ran, so nothing was counted.</div>
        ) : d.total === 0 ? (
          <div className="text-text-muted mt-0.5">Checked, and nothing moved.</div>
        ) : (
          <>
            <div className="text-text-primary tabular-nums mt-1">
              {nf(d.total)} units moved
            </div>
            <div className="flex items-center gap-1.5 text-text-secondary tabular-nums mt-0.5">
              <span className="w-2.5 h-2.5 rounded-sm inline-block" style={OUT_FILL} />
              {nf(d.out)} out
            </div>
            <div className="flex items-center gap-1.5 text-text-secondary tabular-nums">
              <span className="w-2.5 h-2.5 rounded-sm inline-block" style={IN_FILL} />
              {nf(d.in)} in
            </div>
            {d.short ? (
              <div className="text-status-warning mt-1 max-w-[13rem] whitespace-normal">
                Counted from fewer than four books — an undercount.
              </div>
            ) : null}
            {d.backfilled ? (
              <div className="text-text-muted mt-1 max-w-[13rem] whitespace-normal">
                Reconstructed afterwards, not recorded on the night.
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function chartLabel(
  days: { date: string; total: number; ledgered: boolean }[],
  data: MovementsResponse
): string {
  const seen = days.filter((d) => d.ledgered);
  if (seen.length === 0) return "Movements per day. No days in this range were checked.";
  const top = seen.reduce((a, b) => (b.total > a.total ? b : a));
  const low = seen.reduce((a, b) => (b.total < a.total ? b : a));
  const missing = days.length - seen.length;
  return `Movements per day, ${longDate(data.from)} to ${longDate(data.to)}. ${nf(
    data.totals.total
  )} units in total. Highest ${nf(top.total)} on ${longDate(top.date)}, lowest ${nf(
    low.total
  )} on ${longDate(low.date)}.${
    missing ? ` ${missing} days were never checked.` : ""
  } Full figures follow in a table.`;
}
