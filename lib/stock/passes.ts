// Which runs of a business date are worth comparing, and which is "the first
// check" versus "the re-check".
//
// PURE. Takes rows already read from reconciliation_runs.
//
// THE PROBLEM THIS SOLVES. A business date does not have two runs. Measured on
// live data, a single date has between 1 and 7 usable runs — manual re-runs are
// unlimited and unrestricted, and the scheduled re-check pass is skipped whenever
// the primary pass eats its 40s budget (3 of 9 recent days had only one cron run).
// So "run 1" and "run 2" cannot mean "the first and second row by created_at".
//
// A PASS is the equivalence class of runs for a date sharing a lag from that
// date, represented by the last one that COMPLETED. Two manual re-pulls on the
// same afternoon are one pass; the D+1 cron run and the D+3 re-check are two.

import { daysBetween } from "../engine/dates";
import { utcToIstDate } from "../connectors/ist-window";

/**
 * Which pass a run was.
 *
 * `unknown` is not a failure mode to code around — it is the honest answer for
 * every run written before migration 0017, because the re-check pass wrote
 * trigger:'cron' byte-identical to the primary pass.
 */
export type PassRole = "primary" | "recheck" | "adhoc" | "unknown";

export interface RunRow {
  id: string;
  business_date: string;
  status: string;
  trigger: string | null;
  triggered_by: string | null;
  created_at: string;
  completed_at: string | null;
  run_role?: string | null;
  ocr_skipped?: boolean | null;
  recheck_skipped_reason?: string | null;
}

export interface PassRef {
  runId: string;
  businessDate: string;
  role: PassRole;
  /** Whether `role` came from the stored marker or was inferred from the lag. */
  roleSource: "marker" | "inferred";
  /** istDate(completed_at) − businessDate. Derived, never a hardcoded offset. */
  lagDays: number;
  trigger: "cron" | "manual";
  status: "success" | "partial";
  createdAt: string;
  /** Non-null by construction — an incomplete run is not a pass. */
  completedAt: string;
  /** Step 0 was skipped. null before 0017. */
  skipOcr: boolean | null;
  /** True for every run in its lag class except the last one to complete. */
  supersededInLagClass: boolean;
  /** The run finished before the business day had shut. */
  preClose: boolean;
  /**
   * A run_city_snapshots row exists for this run (migration 0017).
   *
   * Set by the caller after reading the snapshot table — toPasses is pure and
   * cannot know. False means the run predates 0017 or its snapshot write failed;
   * either way there is nothing to compare it with.
   */
  hasSnapshot: boolean;
}

/** A run that exists but cannot be compared, and why — shown, not hidden. */
export interface ExcludedRun {
  runId: string;
  createdAt: string;
  status: string;
  reason: "never completed" | "failed";
}

export function lagDaysOf(businessDate: string, completedAtIso: string): number {
  const ist = utcToIstDate(completedAtIso);
  if (!ist) return 0;
  return daysBetween(businessDate, ist);
}

function normTrigger(t: string | null): "cron" | "manual" {
  return t === "manual" ? "manual" : "cron";
}

/**
 * Group a date's runs into passes.
 *
 * A run is USABLE only when its status is success|partial AND completed_at is set.
 * `completed_at`, never `created_at`: createRun stamps created_at at the START, so
 * a run killed by the 60s ceiling keeps a null completed_at forever — and one such
 * row from 2026-07-20 is still stranded at status='running' in production, because
 * prune_expired only sweeps 'failed'. isRerunFresh in the follow-up email already
 * makes exactly this argument.
 *
 * Unusable runs are returned separately rather than dropped: an unexplained hole in
 * a run list is worse than a row labelled "never completed".
 */
export function toPasses(runs: RunRow[]): { passes: PassRef[]; excluded: ExcludedRun[] } {
  const excluded: ExcludedRun[] = [];
  const usable: RunRow[] = [];

  for (const r of runs) {
    const ok = r.status === "success" || r.status === "partial";
    if (ok && r.completed_at) {
      usable.push(r);
    } else {
      excluded.push({
        runId: r.id,
        createdAt: r.created_at,
        status: r.status,
        reason: r.status === "failed" ? "failed" : "never completed",
      });
    }
  }

  const built: PassRef[] = usable.map((r) => {
    const lagDays = lagDaysOf(r.business_date, r.completed_at!);
    const marker = r.run_role;
    const hasMarker =
      marker === "primary" || marker === "recheck" || marker === "adhoc";
    return {
      runId: r.id,
      businessDate: r.business_date,
      role: hasMarker ? (marker as PassRole) : "unknown",
      roleSource: hasMarker ? "marker" : "inferred",
      lagDays,
      trigger: normTrigger(r.trigger),
      status: r.status as "success" | "partial",
      createdAt: r.created_at,
      completedAt: r.completed_at!,
      skipOcr: r.ocr_skipped ?? null,
      supersededInLagClass: false,
      preClose: lagDays <= 0,
      hasSnapshot: false,
    };
  });

  built.sort((a, b) => (a.completedAt < b.completedAt ? -1 : a.completedAt > b.completedAt ? 1 : 0));

  // Within a lag class only the last run to complete describes the date — the
  // earlier ones were superseded the same afternoon. Marked rather than dropped so
  // the picker can still offer them (two manual re-pulls minutes apart is a
  // legitimate thing to want to diff).
  const lastOfClass = new Map<number, string>();
  for (const p of built) lastOfClass.set(p.lagDays, p.runId);
  for (const p of built) p.supersededInLagClass = lastOfClass.get(p.lagDays) !== p.runId;

  // Infer the role only where the marker is absent, and only from the lag RANK —
  // never from a literal +1/+2/+3. The earliest non-preClose lag class is the
  // first check; a later class that the cron produced is a re-check; a human's run
  // is adhoc whatever its lag.
  const classes = [...new Set(built.filter((p) => !p.preClose).map((p) => p.lagDays))].sort(
    (a, b) => a - b
  );
  for (const p of built) {
    if (p.roleSource === "marker") continue;
    if (p.trigger === "manual") {
      p.role = "adhoc";
      continue;
    }
    if (p.preClose) continue; // stays "unknown" — it ran before the day shut
    const rank = classes.indexOf(p.lagDays);
    if (rank === 0) p.role = "primary";
    else if (rank > 0) p.role = "recheck";
  }

  return { passes: built, excluded };
}

/**
 * The pair to open on: earliest usable pass against the latest one after it.
 *
 * Both must have a stored snapshot — without one there is nothing to compare, and
 * offering a pair that yields no numbers is worse than offering none. preClose
 * runs are excluded from the default (a run that fired before the day shut saw a
 * partial day by definition) but remain selectable by hand.
 */
export function defaultPair(passes: PassRef[]): { a: PassRef; b: PassRef } | null {
  const eligible = passes.filter((p) => !p.preClose && p.hasSnapshot);
  if (eligible.length < 2) return null;
  const a = eligible[0];
  const b = [...eligible].reverse().find((p) => p.lagDays > a.lagDays);
  return b ? { a, b } : null;
}
