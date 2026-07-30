"use client";

// What one day's flagged units looked like at the first check, and what happened
// to them by the re-check.
//
// Reading order is coverage → verdict → arithmetic → city → units, and the order
// is the point. The verdict is a GATE, not a footnote: a caveat placed under a
// number is read after the number has already been believed.
//
// When the verdict says showDelta === false, the arithmetic and the
// cleared/raised split DO NOT RENDER. Not greyed, not zeroed — absent. A zero in
// "Cleared" is a lie.

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { EmptyState } from "@/components/empty-state";
import { Skeleton, TableBodySkeleton } from "@/components/skeleton";
import { useStickyState } from "@/lib/hooks/use-sticky-state";
import { TIER } from "@/lib/ui/variance-labels";
import {
  BOOK_LABEL,
  VERDICT_CLASS,
  VERDICT_ICON,
  noHistoryVerdict,
  singlePassVerdict,
  verdictFor,
  type Verdict,
} from "@/lib/ui/recheck-verdict";

interface PassRef {
  runId: string;
  role: string;
  roleSource: string;
  lagDays: number;
  status: string;
  completedAt: string;
  skipOcr: boolean | null;
  hasSnapshot: boolean;
}

interface CityDeltaOut {
  city: string;
  flaggedA: number;
  flaggedB: number;
  stillOpen: number | null;
  cleared: number | null;
  newlyRaised: number | null;
  verdict: string;
  note: string | null;
  restDay: boolean;
  movementsA: number | null;
  movementsB: number | null;
}

interface CompareResponse {
  date: string;
  a: PassRef | null;
  b: PassRef | null;
  degraded: string;
  degradedNote: string | null;
  comparability: {
    clearedTrustworthy: boolean;
    newlyRaisedTrustworthy: boolean;
    headline: string;
    perCity: {
      city: string;
      lostInB: ("P" | "S" | "D" | "O")[];
      lostInA: ("P" | "S" | "D" | "O")[];
    }[];
  } | null;
  totals: {
    flaggedA: number;
    flaggedB: number;
    stillOpen: number | null;
    cleared: number | null;
    newlyRaised: number | null;
    attribution: { humanClosed: number; engineCleared: number; noLongerFlagged: number } | null;
    keysUnknown: boolean;
  } | null;
  cities: CityDeltaOut[];
}

interface PassesResponse {
  state: "ok" | "single-pass" | "no-runs";
  passes: PassRef[];
  singlePassDetail: string | null;
}

interface UnitRow {
  key: string;
  city: string;
  direction: string;
  barcode: string;
  rowPresent: boolean;
  problem: string | null;
  tier: 1 | 2 | 3 | null;
  status: string | null;
  ticketId: string | null;
  product: string | null;
  reason: string | null;
}

const nf = (n: number) => n.toLocaleString("en-IN");
const cityName = (c: string) => c.charAt(0) + c.slice(1).toLowerCase();
const longDate = (d: string) =>
  new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
const shortTime = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });

const CLASSES = [
  { id: "still-open", label: "Still open" },
  { id: "cleared", label: "Cleared" },
  { id: "newly-raised", label: "Raised later" },
] as const;

const REASON_LABEL: Record<string, { text: string; icon: "check" | "history" | "schedule" }> = {
  "human-closed": { text: "Closed by your team", icon: "check" },
  "engine-cleared": { text: "Cleared on its own", icon: "history" },
  "no-longer-flagged": { text: "No longer flagged", icon: "schedule" },
};

export default function DayRecheckPanel({ defaultDate, today }: { defaultDate: string; today: string }) {
  const [date, setDate] = useStickyState<string>("stock.date", defaultDate);
  const [cmp, setCmp] = useState<CompareResponse | null>(null);
  const [passes, setPasses] = useState<PassesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [klass, setKlass] = useState<(typeof CLASSES)[number]["id"]>("still-open");
  const [units, setUnits] = useState<UnitRow[] | null>(null);
  const [unitsTotal, setUnitsTotal] = useState(0);
  const seq = useRef(0);
  const unitSeq = useRef(0);

  /* eslint-disable react-hooks/set-state-in-effect -- setLoading toggles the
     async-fetch loading state; the seq ref supersedes stale responses. Same
     pattern as lib/hooks/use-dashboard-data.ts. */
  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    setErr(null);
    Promise.all([
      fetch(`/api/stock/passes?date=${date}`, { credentials: "same-origin" }).then((r) => r.json()),
      fetch(`/api/stock/compare?date=${date}`, { credentials: "same-origin" }).then((r) => r.json()),
    ])
      .then(([p, c]) => {
        if (mine !== seq.current) return;
        if (p.error || c.error) throw new Error(p.error ?? c.error);
        setPasses(p as PassesResponse);
        setCmp(c as CompareResponse);
      })
      .catch((e) => {
        if (mine !== seq.current) return;
        setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
  }, [date]);

  const verdict: Verdict = useMemo(() => {
    if (!cmp) return noHistoryVerdict();
    if (cmp.degraded === "unavailable" || !cmp.comparability || !cmp.totals) {
      if (passes?.state === "single-pass") return singlePassVerdict(passes.singlePassDetail);
      return noHistoryVerdict();
    }
    const g = cmp.comparability;
    const lostInB = [...new Set(g.perCity.flatMap((c) => c.lostInB))];
    const lostInA = [...new Set(g.perCity.flatMap((c) => c.lostInA))];
    return verdictFor({
      clearedTrustworthy: g.clearedTrustworthy,
      newlyRaisedTrustworthy: g.newlyRaisedTrustworthy,
      lostInB,
      lostInA,
      headline: g.headline || null,
    });
  }, [cmp, passes]);

  // The unit list follows the same gate: with no comparison there are no classes,
  // so it falls back to whatever the latest check found.
  useEffect(() => {
    if (!cmp?.totals) {
      setUnits(null);
      return;
    }
    const mine = ++unitSeq.current;
    setUnits(null);
    const qs = new URLSearchParams({ date, class: klass, pageSize: "100" });
    fetch(`/api/stock/units?${qs}`, { credentials: "same-origin" })
      .then((r) => r.json())
      .then((j) => {
        if (mine !== unitSeq.current) return;
        setUnits(j.rows ?? []);
        setUnitsTotal(j.total ?? 0);
      })
      .catch(() => {
        if (mine === unitSeq.current) setUnits([]);
      });
  }, [date, klass, cmp]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const shiftDay = (n: number) => {
    const [y, m, d] = date.split("-").map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
    if (next <= today) setDate(next);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="sa-date" className="text-xs text-text-muted hidden sm:inline">
          Business day
        </label>
        <button className="btn btn-icon" aria-label="Previous day" onClick={() => shiftDay(-1)}>
          <Icon name="chevron_left" size={18} />
        </button>
        <input
          id="sa-date"
          type="date"
          className="input-clean cursor-pointer"
          value={date}
          max={today}
          onChange={(e) => e.target.value && setDate(e.target.value)}
        />
        <button className="btn btn-icon" aria-label="Next day" onClick={() => shiftDay(1)}>
          <Icon name="chevron_right" size={18} />
        </button>
      </div>

      {err ? (
        <div className="card p-4 bg-danger-soft border border-danger/20 text-sm text-danger font-semibold">
          We could not load {longDate(date)}. {err}
        </div>
      ) : loading ? (
        <div className="space-y-6">
          <Skeleton className="h-40 w-full rounded-card" />
          <Skeleton className="h-24 w-full rounded-card" />
          <Skeleton className="h-56 w-full rounded-card" />
        </div>
      ) : passes?.state === "no-runs" ? (
        <div className="card p-6">
          <EmptyState
            icon="event_busy"
            title="This day has not been checked yet"
            detail={`Nothing has been reconciled for ${longDate(date)}. Pick an earlier day.`}
          />
        </div>
      ) : (
        <>
          {/* ── The two checks ──────────────────────────────────────────── */}
          <section className="card p-6 space-y-4">
            <h2 className="font-headline text-lg text-text-primary">The two checks</h2>
            <p className="text-sm text-text-muted">
              Every unit is compared against four books — the guard&apos;s book, the ops sheet, the
              delivery app and Odoo. A check that could not read all four sees less, so it finds
              less.
            </p>

            {cmp?.a && cmp?.b ? (
              <div className="overflow-x-auto">
                <table className="table-clean">
                  <thead>
                    <tr>
                      <th scope="col">Book</th>
                      <th scope="col">First check · {shortTime(cmp.a.completedAt)}</th>
                      <th scope="col">Re-check · {shortTime(cmp.b.completedAt)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(["P", "S", "D", "O"] as const).map((s) => {
                      const lostB = cmp.comparability?.perCity.some((c) => c.lostInB.includes(s));
                      const lostA = cmp.comparability?.perCity.some((c) => c.lostInA.includes(s));
                      return (
                        <tr key={s}>
                          <th scope="row" className="font-normal">
                            {BOOK_LABEL[s].charAt(0).toUpperCase() + BOOK_LABEL[s].slice(1)}
                          </th>
                          <BookCell missing={!!lostA} />
                          <BookCell missing={!!lostB} />
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-text-secondary">
                Only one check has run for {longDate(date)}.
              </p>
            )}

            {/* THE GATE */}
            <div className={VERDICT_CLASS[verdict.tone]}>
              <div className="flex gap-3">
                <Icon name={VERDICT_ICON[verdict.tone] as "warning"} size={18} className="shrink-0 mt-0.5" />
                <div className="text-sm space-y-1">
                  <p className="font-semibold text-text-primary">{verdict.title}</p>
                  <p className="text-text-secondary">{verdict.body}</p>
                </div>
              </div>
            </div>

            {/* Each check's own totals stay available even when the pair cannot be
                compared — but side by side, with no arrow and no percentage. */}
            {!verdict.showDelta && cmp?.totals ? (
              <details className="text-sm">
                <summary className="cursor-pointer text-text-secondary">
                  Show what each check counted
                </summary>
                <div className="mt-3 space-y-2 text-text-secondary">
                  <p className="text-xs text-text-muted">
                    These are each check&apos;s own totals. They are not a before-and-after.
                  </p>
                  <p>
                    <strong>First check</strong> · {nf(cmp.totals.flaggedA)} units needing action
                  </p>
                  <p>
                    <strong>Re-check</strong> · {nf(cmp.totals.flaggedB)} units needing action
                  </p>
                </div>
              </details>
            ) : null}
          </section>

          {/* ── What changed ────────────────────────────────────────────── */}
          {verdict.showDelta && cmp?.totals ? (
            <section className="space-y-4">
              <h2 className="font-headline text-lg text-text-primary">
                What changed since the first check
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-gutter">
                <Tile mod="kpi-tile kpi-tile--accent" label="Flagged on the first check"
                  value={nf(cmp.totals.flaggedA)}
                  caption="Units the first check could not fully account for" />
                <Tile mod="kpi-tile kpi-tile--success" label="Cleared since"
                  value={cmp.totals.cleared == null ? "—" : nf(cmp.totals.cleared)}
                  caption="Settled by your team, or filled in on their own" />
                <Tile mod="kpi-tile kpi-tile--danger" label="Still open"
                  value={cmp.totals.stillOpen == null ? "—" : nf(cmp.totals.stillOpen)}
                  caption={`Outstanding since ${longDate(date)}`} />
                <Tile mod="kpi-tile kpi-tile--warning" label="Raised later"
                  value={cmp.totals.newlyRaised == null ? "—" : nf(cmp.totals.newlyRaised)}
                  caption="Flagged for this day after the first check" />
              </div>

              {/* The equation strip — the arithmetic made self-evident. */}
              <div className="bg-surface-elevated rounded-control px-4 py-3 text-sm text-text-primary space-y-1">
                <p>
                  <strong>
                    {nf(cmp.totals.flaggedA)} flagged − {nf(cmp.totals.cleared ?? 0)} cleared ={" "}
                    {nf(cmp.totals.stillOpen ?? 0)} still open.
                  </strong>
                </p>
                {cmp.totals.attribution ? (
                  <p className="text-text-secondary">
                    Of the {nf(cmp.totals.cleared ?? 0)} cleared, your team closed{" "}
                    {nf(cmp.totals.attribution.humanClosed)} and{" "}
                    {nf(cmp.totals.attribution.engineCleared + cmp.totals.attribution.noLongerFlagged)}{" "}
                    filled themselves in as late entries arrived.
                  </p>
                ) : null}
                {cmp.totals.newlyRaised ? (
                  <p className="text-text-secondary">
                    A further {nf(cmp.totals.newlyRaised)} were flagged for {longDate(date)} after
                    the first check. They are not part of the sum above, so{" "}
                    {nf((cmp.totals.stillOpen ?? 0) + cmp.totals.newlyRaised)} are open on that day
                    now.
                  </p>
                ) : null}
              </div>
            </section>
          ) : null}

          {/* ── City by city ────────────────────────────────────────────── */}
          {cmp && cmp.cities.length > 0 ? (
            <section className="card overflow-hidden">
              <h2 className="font-headline text-lg text-text-primary p-6 pb-3">City by city</h2>
              <div className="overflow-x-auto">
                <table className="table-clean">
                  <thead>
                    <tr>
                      <th scope="col">City</th>
                      <th scope="col" className="text-right">Flagged first check</th>
                      <th scope="col" className="text-right">Cleared</th>
                      <th scope="col" className="text-right">Still open</th>
                      <th scope="col" className="text-right">Raised later</th>
                      <th scope="col">Books read</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...cmp.cities]
                      .sort((a, b) => (b.stillOpen ?? -1) - (a.stillOpen ?? -1))
                      .map((c) => (
                        <tr key={c.city}>
                          <th scope="row" className="font-normal">{cityName(c.city)}</th>
                          <td className="text-right tabular-nums">{nf(c.flaggedA)}</td>
                          <td className="text-right tabular-nums">
                            {c.cleared == null ? "—" : nf(c.cleared)}
                          </td>
                          <td className="text-right tabular-nums">
                            {c.stillOpen == null ? "—" : nf(c.stillOpen)}
                          </td>
                          <td className="text-right tabular-nums">
                            {c.newlyRaised == null ? "—" : nf(c.newlyRaised)}
                          </td>
                          <td>
                            {c.restDay ? (
                              <span className="badge badge-suppressed">Closed that day</span>
                            ) : c.verdict === "ok" ? (
                              <span className="text-text-muted text-xs">4 of 4</span>
                            ) : (
                              <span className="badge badge-medium" title={c.note ?? undefined}>
                                Not all four
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-text-muted p-6 pt-3">
                Ordered by how many are still open. A dash means we cannot say — either the
                warehouse was shut, or the two checks did not read the same books. That is not the
                same as zero.
              </p>
            </section>
          ) : null}

          {/* ── The units ───────────────────────────────────────────────── */}
          {verdict.showDelta && cmp?.totals ? (
            <section className="card overflow-hidden">
              <div className="p-6 pb-3 flex flex-wrap items-center justify-between gap-3">
                <h2 className="font-headline text-lg text-text-primary">The units</h2>
                <div
                  className="bg-surface-elevated rounded-control p-1 flex"
                  role="radiogroup"
                  aria-label="Which units to show"
                >
                  {CLASSES.map((c) => {
                    const active = klass === c.id;
                    return (
                      <button
                        key={c.id}
                        role="radio"
                        aria-checked={active}
                        onClick={() => setKlass(c.id)}
                        className={
                          active
                            ? "px-4 py-1.5 text-sm font-medium rounded-control bg-surface-card shadow-card"
                            : "px-4 py-1.5 text-sm text-text-secondary rounded-control hover:bg-surface-card transition-colors duration-150"
                        }
                      >
                        {c.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="table-clean">
                  <thead>
                    <tr>
                      <th scope="col">What happened</th>
                      <th scope="col">Warehouse</th>
                      <th scope="col">Direction</th>
                      <th scope="col">Unit</th>
                      <th scope="col">Problem</th>
                      <th scope="col">Ticket</th>
                    </tr>
                  </thead>
                  <tbody>
                    {units === null ? (
                      <TableBodySkeleton rows={6} cols={6} />
                    ) : units.length === 0 ? (
                      <tr>
                        <td colSpan={6}>
                          <EmptyState
                            compact
                            icon="search_off"
                            title="Nothing in this group"
                            detail={`No units are ${CLASSES.find((c) => c.id === klass)!.label.toLowerCase()} for ${longDate(date)}.`}
                          />
                        </td>
                      </tr>
                    ) : (
                      units.map((u) => {
                        const r = u.reason ? REASON_LABEL[u.reason] : null;
                        return (
                          <tr key={u.key}>
                            <td>
                              {r ? (
                                <span className="badge badge-done inline-flex items-center gap-1">
                                  <Icon name={r.icon} size={12} />
                                  {r.text}
                                </span>
                              ) : klass === "newly-raised" ? (
                                <span className="badge badge-medium">Raised later</span>
                              ) : (
                                <span className="badge badge-suppressed">Still open</span>
                              )}
                            </td>
                            <td>{cityName(u.city)}</td>
                            <td>{u.direction === "IN" ? "In" : u.direction === "OUT" ? "Out" : "In + out"}</td>
                            <td className="font-mono text-xs">{u.barcode}</td>
                            <td>
                              <span className="text-text-primary">{u.problem ?? "—"}</span>
                              {u.tier ? (
                                <span className={`${TIER[u.tier].badge} ml-2`}>
                                  {TIER[u.tier].heading}
                                </span>
                              ) : null}
                            </td>
                            <td className="text-text-muted">{u.ticketId ?? "—"}</td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
              {units && units.length > 0 && unitsTotal > units.length ? (
                <p className="text-xs text-text-muted p-6 pt-3">
                  Showing the first {units.length} of {nf(unitsTotal)}.
                </p>
              ) : null}
              <p className="text-xs text-text-muted p-6 pt-0">
                A unit that has since cleared keeps its barcode and its problem, but not its full
                detail — once a record is settled it is not kept in full.
              </p>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

function BookCell({ missing }: { missing: boolean }) {
  return missing ? (
    <td>
      <span className="inline-flex items-center gap-1.5 text-danger font-semibold">
        <Icon name="error" size={14} />
        Did not answer
      </span>
    </td>
  ) : (
    <td>
      <span className="inline-flex items-center gap-1.5 text-text-secondary">
        <Icon name="check_circle" size={14} className="text-success" />
        Read
      </span>
    </td>
  );
}

function Tile({ mod, label, value, caption }: { mod: string; label: string; value: string; caption: string }) {
  return (
    <div className={mod}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="text-xs text-text-muted mt-1">{caption}</div>
    </div>
  );
}
