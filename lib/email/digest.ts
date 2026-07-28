// Builds the daily reconciliation digest — the data shape + the email HTML/text.
// Two producers: from a fresh engine run (cron path) and from persisted
// variances (manual / test-send path), so the same email renders either way.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MultiCityRun } from "../engine/run";
import { VARIANCE } from "../engine/variance-names";
import { isCityOff, OFF_LABEL } from "../engine/schedule";
import type { City } from "../sample-data";

// Per-source, per-direction movement counts for one city (migration 0012).
// `reported` is separate from the counts on purpose: a zero cannot tell "the
// connector was down" from "nothing moved", and the email must not guess.
export interface CityMovementCounts {
  sheetIn: number;
  sheetOut: number;
  odooIn: number;
  odooOut: number;
  dtIn: number;
  dtOut: number;
  physIn: number;
  physOut: number;
  reported: { P: boolean; S: boolean; D: boolean; O: boolean };
}

export interface CityDigestRow {
  city: string;
  accuracy: number | null; // 1 - real/movements, %
  open: number; // open REAL variances (the chase list)
  ppBox: number; // count-only PP-box movements
  topIssue: string | null; // dominant REAL category, short label + count ("Odoo lag (57)")
  real: number; // REAL detected (as-found)
  info: number;
  total: number;
  high: number;
  // Absent when migration 0012 has not been applied, or for dates reconciled
  // before it was — the movement table is then omitted rather than showing zeros.
  counts?: CityMovementCounts;
}

// What did NOT arrive for a city on this date. Guard status is read from
// guard_uploads directly rather than inferred from reported_p, because that
// distinguishes "never uploaded" from "uploaded but OCR has not finished" —
// which are different asks of a different person.
export interface CityGap {
  city: string;
  register: "missing" | "pending" | "failed" | null;
  opsSheet: boolean; // true = the ops sheet had no rows for this city/date
}

export interface DigestData {
  date: string; // business date reconciled (YYYY-MM-DD)
  generatedAt: string; // ISO timestamp
  totals: { total: number; real: number; info: number; high: number };
  cities: CityDigestRow[]; // sorted REAL desc
  sources?: { source: string; ok: boolean; rows: number }[];
  gaps?: CityGap[]; // cities missing a register and/or ops-sheet rows
  /** True when no completed reconciliation exists for `date` — see the banner. */
  runIncomplete?: boolean;
}

const clampPct = (x: number) => Math.round(Math.max(0, Math.min(100, x)) * 10) / 10;
const accuracyOf = (movements: number, real: number): number | null =>
  movements > 0 ? clampPct((1 - real / movements) * 100) : null;

// Short category label for the dominant variance type — the "Top Gap" column.
// Keyed by the canonical variance names so it never drifts on a rename.
const SHORT_LABEL: Record<string, string> = {
  [VARIANCE.WRONG_SCAN]: "Wrong scan",
  [VARIANCE.FLOOR_DT_NOT_ODOO]: "Odoo not posted",
  [VARIANCE.GATE_OPS_NO_DT_ODOO]: "No DT/Odoo",
  [VARIANCE.GATE_ONLY]: "Gate only",
  [VARIANCE.SHEET_ONLY]: "Sheet only",
  [VARIANCE.OPS_ODOO_NO_GATE]: "Gate missing",
  [VARIANCE.PICKUP_ODOO_OPEN]: "Odoo not closed",
  [VARIANCE.DT_ONLY]: "DT only",
  [VARIANCE.REPLACEMENT_CONFIRM]: "Replacement",
  [VARIANCE.FAILED_DELIVERY]: "Failed delivery",
  [VARIANCE.SHEET_NOT_DONE_BUT_POSTED]: "Sheet/system disagree",
  [VARIANCE.ODOO_ONLY_TODAY]: "Odoo-only (today)",
  [VARIANCE.ODOO_ONLY]: "Odoo only",
  [VARIANCE.ODOO_POSTED_NEXT_DAY]: "Odoo late entry",
  [VARIANCE.OPS_ODOO_NO_DT]: "No DT scan",
  [VARIANCE.DT_ODOO_NO_SHEET]: "Sheet missing",
  [VARIANCE.GATE_OPS_ODOO_NO_DT]: "DT pending",
  [VARIANCE.GATE_ODOO_NO_OPS_DT]: "Ops/DT gap",
  [VARIANCE.OPS_DT_ODOO_PENDING]: "Odoo pending",
  [VARIANCE.FIELD_MISMATCH]: "Barcode text",
  [VARIANCE.DUPLICATE]: "Duplicate",
  [VARIANCE.ADJACENT_DAY]: "Wrong-day entry",
};

function shortLabel(name: string): string {
  return SHORT_LABEL[name] ?? name;
}

function topIssueOf(names: string[]): string | null {
  if (names.length === 0) return null;
  const tally: Record<string, number> = {};
  for (const n of names) tally[n] = (tally[n] ?? 0) + 1;
  const [name, count] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  return `${shortLabel(name)} (${count})`;
}

// From a live engine run (cron): read straight off the per-city summaries.
export function buildDigestFromRun(
  run: MultiCityRun,
  sources?: { source: string; ok: boolean; rows: number }[]
): DigestData {
  const cities: CityDigestRow[] = run.perCity.map((c) => ({
    city: c.city,
    accuracy: accuracyOf(c.summary.movements, c.summary.real_count),
    open: c.summary.real_count, // freshly reconciled — every REAL is open
    ppBox: c.summary.pp_box_count,
    topIssue: topIssueOf(c.real_variances.map((v) => v.variance_name)),
    real: c.summary.real_count,
    info: c.summary.info_count,
    total: c.summary.total,
    high: c.summary.high_priority,
  }));
  cities.sort((a, b) => b.open - a.open);
  return {
    date: run.date,
    generatedAt: run.ranAt,
    totals: {
      total: run.combined.total,
      real: run.combined.real_count,
      info: run.combined.info_count,
      high: run.combined.high_priority,
    },
    cities,
    sources,
  };
}

// From persisted variances (manual / "Send test"): aggregate the stored rows
// for a business date. Avoids re-pulling the 4 sources just to preview an email.
export async function buildDigestFromDb(
  db: SupabaseClient,
  businessDate: string
): Promise<DigestData> {
  // Scope to the LATEST successful run of the date — the same run the
  // dashboard KPIs count. Without this the digest tallied rows from EVERY run
  // of the date, stale strays included (2026-07-21: emailed "563 to action"
  // while the run held 555 and the dashboard showed its own truncated count).
  const { data: runs } = await db
    .from("reconciliation_runs")
    .select("id")
    .eq("business_date", businessDate)
    .in("status", ["success", "partial"])
    .order("created_at", { ascending: false })
    .limit(1);
  const runId = runs?.[0]?.id as string | undefined;

  let rows: {
    city: string;
    bucket: string;
    priority: string;
    status: string;
    variance_name: string;
  }[] = [];
  let from = 0;
  for (;;) {
    let q = db
      .from("variances")
      .select("city,bucket,priority,status,variance_name")
      .eq("business_date", businessDate);
    if (runId) q = q.eq("run_id", runId);
    // Deterministic order — .range() without a unique sort key lets Postgres
    // return a different physical order per request, duplicating or dropping
    // rows across page boundaries (same lesson as app/api/variances/route.ts).
    const { data, error } = await q
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`buildDigestFromDb: ${error.message}`);
    rows = rows.concat(data ?? []);
    if (!data || data.length < 1000) break;
    from += 1000;
  }

  // Per-city movements / pp-box / real-count for accuracy + PP (the variance
  // table no longer carries PP-box or consumable rows — see run_city_stats).
  // Try the 0012 columns first. If the migration has not been applied the
  // select 42703s, so fall back to the legacy set and simply omit the movement
  // table — an email without one beats an email that fails to build.
  // Explicit shape: the 0012 columns are optional so the legacy fallback
  // below type-checks against the same variable.
  type CityStatRow = {
    city: string;
    movements: number | null;
    real_count: number | null;
    pp_box_count: number | null;
    sheet_in?: number | null; sheet_out?: number | null;
    odoo_in?: number | null; odoo_out?: number | null;
    dt_in?: number | null; dt_out?: number | null;
    phys_in?: number | null; phys_out?: number | null;
    reported_p?: boolean | null; reported_s?: boolean | null;
    reported_d?: boolean | null; reported_o?: boolean | null;
  };
  let stats: CityStatRow[] | null = null;
  let hasCounts = true;
  {
    const full = await db
      .from("run_city_stats")
      .select(
        "city, movements, real_count, pp_box_count, sheet_in, sheet_out, odoo_in, odoo_out, dt_in, dt_out, phys_in, phys_out, reported_p, reported_s, reported_d, reported_o"
      )
      .eq("business_date", businessDate);
    if (full.error) {
      hasCounts = false;
      const legacy = await db
        .from("run_city_stats")
        .select("city, movements, real_count, pp_box_count")
        .eq("business_date", businessDate);
      stats = (legacy.data ?? []) as CityStatRow[];
    } else {
      stats = (full.data ?? []) as CityStatRow[];
    }
  }
  const statByCity = new Map((stats ?? []).map((s) => [s.city, s]));

  // Register status per city, straight from guard_uploads — richer than
  // reported_p, which conflates "no upload" with "uploaded but not processed".
  const { data: uploads } = await db
    .from("guard_uploads")
    .select("city, status")
    .eq("business_date", businessDate);
  const uploadByCity = new Map<string, string[]>();
  for (const u of uploads ?? []) {
    const list = uploadByCity.get(u.city as string) ?? [];
    list.push(u.status as string);
    uploadByCity.set(u.city as string, list);
  }

  const byCity = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!byCity.has(r.city)) byCity.set(r.city, []);
    byCity.get(r.city)!.push(r);
  }
  for (const s of stats ?? []) if (!byCity.has(s.city)) byCity.set(s.city, []);

  const cities: CityDigestRow[] = [];
  for (const [city, cr] of byCity) {
    const realRows = cr.filter((v) => v.bucket === "REAL");
    const st = statByCity.get(city);
    cities.push({
      city,
      accuracy: accuracyOf(st?.movements ?? 0, st?.real_count ?? realRows.length),
      open: realRows.filter((v) => v.status !== "closed").length,
      ppBox: st?.pp_box_count ?? 0,
      topIssue: topIssueOf(realRows.map((v) => v.variance_name)),
      real: realRows.length,
      info: cr.length - realRows.length,
      total: cr.length,
      high: cr.filter((v) => v.priority === "High").length,
      counts:
        hasCounts && st
          ? {
              sheetIn: Number(st.sheet_in ?? 0),
              sheetOut: Number(st.sheet_out ?? 0),
              odooIn: Number(st.odoo_in ?? 0),
              odooOut: Number(st.odoo_out ?? 0),
              dtIn: Number(st.dt_in ?? 0),
              dtOut: Number(st.dt_out ?? 0),
              physIn: Number(st.phys_in ?? 0),
              physOut: Number(st.phys_out ?? 0),
              reported: {
                P: !!st.reported_p,
                S: !!st.reported_s,
                D: !!st.reported_d,
                O: !!st.reported_o,
              },
            }
          : undefined,
    });
  }
  cities.sort((a, b) => b.open - a.open);

  // Gaps: what did not arrive. Skip cities that were closed — an absent
  // register on a weekly off is expected, not a chase item.
  const gaps: CityGap[] = [];
  for (const c of cities) {
    if (isCityOff(c.city as City, businessDate)) continue;
    const statuses = uploadByCity.get(c.city) ?? [];
    let register: CityGap["register"] = null;
    if (statuses.length === 0) register = "missing";
    else if (statuses.includes("processed")) register = null;
    else if (statuses.includes("failed")) register = "failed";
    else register = "pending"; // pending / ocr_running / needs_review
    // The ops sheet is missing when the connector reported nothing for the city.
    // Only trustworthy once 0012 is applied; otherwise leave it unclaimed.
    const st = statByCity.get(c.city);
    const opsSheet = hasCounts && !!st ? !st.reported_s : false;
    if (register || opsSheet) gaps.push({ city: c.city, register, opsSheet });
  }

  return {
    date: businessDate,
    generatedAt: new Date().toISOString(),
    totals: {
      total: rows.length,
      real: rows.filter((v) => v.bucket === "REAL").length,
      info: rows.filter((v) => v.bucket === "INFO").length,
      high: rows.filter((v) => v.priority === "High").length,
    },
    cities,
    gaps,
    // No run rows at all for the date means the reconcile never completed.
    runIncomplete: !runId,
  };
}

function fmtDate(d: string): string {
  // "2026-07-13" → "13 July 2026" without TZ drift.
  const [y, m, day] = d.split("-").map(Number);
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  if (!y || !m || !day) return d;
  return `${day} ${months[m - 1]} ${y}`;
}

// Quotes are escaped too: esc() already feeds an attribute (href="${esc(...)}"
// below), so a value containing a quote would break out of it. Harmless for
// today's constant URL, not harmless once DB text (customer, product, SO) is
// interpolated into a title="..." tooltip.
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export function digestSubject(data: DigestData): string {
  return `Cityfurnish Reconciliation — ${fmtDate(data.date)} — ${data.totals.real} to action`;
}

// Email-client-safe HTML: tables + inline styles only (no fl+grid, no <style>).
export function renderDigestHtml(
  data: DigestData,
  dashboardUrl?: string,
  notes?: string,
  attachmentNote?: string
): string {
  const dateLabel = fmtDate(data.date);
  // Brand as a text wordmark, not an image. A hosted logo is unreliable in email:
  // Gmail strips inline/base64, and an /apple-icon.png on a protected Vercel
  // deployment URL 403s (shows a broken image). Plain styled text always renders.
  const brand = `<span style="font-size:22px;font-weight:800;letter-spacing:-0.4px;color:#111827;font-family:Helvetica,Arial,sans-serif;">Cityfurnish</span>`;
  const cityRows = data.cities
    .map((c) => {
      // Weekly holiday: the city was closed — absent floor data is expected,
      // so render OFF instead of numbers that read like gaps.
      const off = isCityOff(c.city as City, data.date);
      const flag = !off && c.open > 0;
      const nameStyle = flag ? "color:#b91c1c;font-weight:700;" : "color:#111827;";
      const bg = flag ? "background:#fef2f2;" : "";
      const acc = off ? "OFF" : c.accuracy === null ? "—" : `${c.accuracy}%`;
      const topGap = off
        ? `<span style="color:#9ca3af;">${OFF_LABEL}</span>`
        : c.topIssue
          ? esc(c.topIssue)
          : "—";
      return `
      <tr style="${bg}">
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;${nameStyle}">${esc(c.city)}${off ? ` <span style="font-size:10px;color:#9ca3af;letter-spacing:1px;">(OFF)</span>` : ""}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:right;color:${off ? "#9ca3af" : "#111827"};">${acc}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:right;${flag ? "color:#b91c1c;font-weight:700;" : "color:#6b7280;"}">${c.open}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:right;color:#6b7280;">${c.ppBox}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#374151;font-size:12px;">${topGap}</td>
      </tr>`;
    })
    .join("");

  const sourceLine = data.sources
    ? `<p style="margin:0 0 4px;color:#6b7280;font-size:12px;">Sources: ${data.sources
        .map((s) => `${esc(s.source)} ${s.ok ? s.rows : "FAIL"}`)
        .join(" · ")}</p>`
    : "";

  // ── Movement Summary: per-city IN/OUT for each of the four sources ────────
  // Only rendered when migration 0012 has populated the counts; a table of
  // zeros would read as "nothing moved" rather than "we don't know".
  const withCounts = data.cities.filter((c) => c.counts);
  const cell = (n: number, reported: boolean) =>
    reported
      ? `<td style="padding:7px 4px;border-bottom:1px solid #e5e7eb;text-align:center;font-variant-numeric:tabular-nums;">${n}</td>`
      : // A dash, not a 0 — the source did not report, which is not the same as
        // no movements. Explained in the footnote below.
        `<td style="padding:7px 4px;border-bottom:1px solid #e5e7eb;text-align:center;color:#b91c1c;" title="source did not report">&ndash;</td>`;

  const movementTable =
    withCounts.length === 0
      ? ""
      : `
        <p style="margin:26px 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#6b7280;font-weight:700;">Movement Summary</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="background:#f3f4f6;">
              <th rowspan="2" style="padding:6px 8px;text-align:left;border-bottom:1px solid #e5e7eb;color:#374151;font-size:11px;">City</th>
              <th colspan="2" style="padding:6px 4px;text-align:center;border-bottom:1px solid #e5e7eb;color:#374151;font-size:11px;">Register</th>
              <th colspan="2" style="padding:6px 4px;text-align:center;border-bottom:1px solid #e5e7eb;color:#374151;font-size:11px;">Odoo</th>
              <th colspan="2" style="padding:6px 4px;text-align:center;border-bottom:1px solid #e5e7eb;color:#374151;font-size:11px;">Delivery Tracker</th>
              <th colspan="2" style="padding:6px 4px;text-align:center;border-bottom:1px solid #e5e7eb;color:#374151;font-size:11px;">Security Guards</th>
            </tr>
            <tr style="background:#f3f4f6;">
              ${["Out", "In", "Out", "In", "Out", "In", "Out", "In"]
                .map(
                  (h) =>
                    `<th style="padding:3px 4px;text-align:center;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:10px;font-weight:600;">${h}</th>`
                )
                .join("")}
            </tr>
          </thead>
          <tbody>
            ${withCounts
              .map((c) => {
                const k = c.counts!;
                const r = k.reported;
                return `<tr>
                  <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;color:#111827;">${esc(c.city)}</td>
                  ${cell(k.sheetOut, r.S)}${cell(k.sheetIn, r.S)}
                  ${cell(k.odooOut, r.O)}${cell(k.odooIn, r.O)}
                  ${cell(k.dtOut, r.D)}${cell(k.dtIn, r.D)}
                  ${cell(k.physOut, r.P)}${cell(k.physIn, r.P)}
                </tr>`;
              })
              .join("")}
          </tbody>
        </table>
        <p style="margin:6px 0 0;color:#9ca3af;font-size:11px;line-height:1.5;">
          Movements that entered reconciliation (PP boxes, spares and unreadable barcodes excluded).
          A red dash means that source reported nothing for the city &mdash; not that nothing moved.
          Odoo and Delivery Tracker are counted on the 15:00&ndash;15:00 business day; Register and
          Security Guards on their written date, so morning movements can sit on either side.
        </p>`;

  // ── Missing sources: what did not arrive, and from whom ───────────────────
  const gapBlock =
    !data.gaps || data.gaps.length === 0
      ? ""
      : `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;margin:0 0 18px;">
          <tr><td style="padding:14px 16px;color:#991b1b;font-size:13px;line-height:1.6;">
            <strong style="display:block;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#b91c1c;margin-bottom:6px;">Not received for this date</strong>
            ${data.gaps
              .map((g) => {
                const bits: string[] = [];
                if (g.register === "missing") bits.push("guard register not uploaded");
                if (g.register === "pending") bits.push("guard register uploaded but not yet processed");
                if (g.register === "failed") bits.push("guard register OCR failed");
                if (g.opsSheet) bits.push("no ops-sheet rows");
                return `<div>&bull; <strong>${esc(g.city)}</strong> &mdash; ${esc(bits.join("; "))}</div>`;
              })
              .join("")}
            <div style="margin-top:6px;color:#7f1d1d;font-size:12px;">These cities reconciled without that source, so their figures below are incomplete.</div>
          </td></tr>
        </table>`;

  // ── Incomplete run banner ─────────────────────────────────────────────────
  const incompleteBanner = data.runIncomplete
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;margin:0 0 18px;">
         <tr><td style="padding:14px 16px;color:#92400e;font-size:13px;line-height:1.6;">
           <strong style="display:block;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#b45309;margin-bottom:5px;">Reconciliation did not complete</strong>
           No finished reconciliation exists for ${esc(fmtDate(data.date))}. The figures below are whatever was
           recorded for that date previously and may be stale or absent. Check System Health before acting on them.
         </td></tr>
       </table>`
    : "";

  const cta = dashboardUrl
    ? `<div style="text-align:center;margin:28px 0 8px;">
         <a href="${esc(dashboardUrl)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:13px;letter-spacing:1px;text-transform:uppercase;font-weight:700;">View Full Dashboard &rarr;</a>
       </div>`
    : "";

  // Optional admin note — an amber callout between the header and the stats.
  const noteBlock = notes && notes.trim()
    ? `<tr><td style="padding:20px 32px 0;">
         <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;">
           <tr><td style="padding:14px 16px;color:#92400e;font-size:13px;line-height:1.55;">
             <strong style="display:block;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#b45309;margin-bottom:5px;">Note from the admin</strong>
             ${esc(notes.trim()).replace(/\n/g, "<br/>")}
           </td></tr>
         </table>
       </td></tr>`
    : "";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
        <tr><td style="padding:28px 32px 20px;border-bottom:1px solid #e5e7eb;">
          <table role="presentation" width="100%"><tr>
            <td>${brand}</td>
            <td style="text-align:right;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#9ca3af;">Daily Digest</td>
          </tr></table>
          <h2 style="margin:18px 0 6px;font-size:18px;color:#111827;">Warehouse Reconciliation Report</h2>
          <p style="margin:0;color:#6b7280;font-size:13px;">${dateLabel} — business day reconciled.</p>
        </td></tr>

        ${noteBlock}

        <tr><td style="padding:24px 32px;background:#f9fafb;">
          ${incompleteBanner}
          ${gapBlock}
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:22px;"><tr>
            <td width="50%" style="padding:14px;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;text-align:center;">
              <div style="font-size:11px;color:#6b7280;margin-bottom:4px;">Losses to Action</div>
              <div style="font-size:20px;font-weight:800;color:#b91c1c;">${data.totals.real}</div>
            </td>
            <td width="8"></td>
            <td width="50%" style="padding:14px;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;text-align:center;">
              <div style="font-size:11px;color:#6b7280;margin-bottom:4px;">High Priority</div>
              <div style="font-size:20px;font-weight:800;color:#111827;">${data.totals.high}</div>
            </td>
          </tr></table>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;background:#ffffff;">
            <thead><tr style="background:#f3f4f6;">
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#6b7280;">City</th>
              <th style="padding:10px 12px;text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#6b7280;">Accuracy</th>
              <th style="padding:10px 12px;text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#6b7280;">Open</th>
              <th style="padding:10px 12px;text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#6b7280;">PP</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#6b7280;">Top Gap</th>
            </tr></thead>
            <tbody>${cityRows}</tbody>
          </table>
          <p style="margin:12px 0 0;color:#9ca3af;font-size:12px;">Cities with open items are highlighted red. Accuracy = 1 − REAL/movements. Open = REAL variances to chase. PP = count-only packing-box movements. Top Gap = the dominant variance category (Odoo lag / Reg only / DT only …).</p>
          ${movementTable}
          ${cta}
        </td></tr>

        <tr><td style="padding:20px 32px;border-top:1px solid #e5e7eb;background:#f9fafb;text-align:center;">
          ${sourceLine}
          ${attachmentNote ? `<p style="margin:0 0 6px;color:#9ca3af;font-size:12px;">No city registers attached &mdash; ${esc(attachmentNote)}.</p>` : ""}
          <p style="margin:0;color:#9ca3af;font-size:12px;">Automated report from the Cityfurnish Operations Portal. Reply to this address to reach the Reconciliation team.</p>
          <p style="margin:6px 0 0;color:#d1d5db;font-size:11px;">© ${new Date().getFullYear()} Cityfurnish Logistics · Internal use only.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export function renderDigestText(
  data: DigestData,
  notes?: string,
  attachmentNote?: string
): string {
  const lines: string[] = [];
  lines.push(`CITYFURNISH — Warehouse Reconciliation — ${fmtDate(data.date)}`);
  lines.push("");
  if (notes && notes.trim()) {
    lines.push(`NOTE FROM THE ADMIN: ${notes.trim()}`);
    lines.push("");
  }
  if (data.runIncomplete) {
    lines.push("!! RECONCILIATION DID NOT COMPLETE for this date — figures below may be stale.");
    lines.push("");
  }
  if (data.gaps && data.gaps.length > 0) {
    lines.push("NOT RECEIVED FOR THIS DATE:");
    for (const g of data.gaps) {
      const bits: string[] = [];
      if (g.register === "missing") bits.push("guard register not uploaded");
      if (g.register === "pending") bits.push("guard register not yet processed");
      if (g.register === "failed") bits.push("guard register OCR failed");
      if (g.opsSheet) bits.push("no ops-sheet rows");
      lines.push(`  - ${g.city}: ${bits.join("; ")}`);
    }
    lines.push("");
  }
  lines.push(`Losses to action (REAL) ${data.totals.real} | High ${data.totals.high}`);
  lines.push("");
  lines.push("CITY          ACC%   OPEN   PP   TOP GAP");
  for (const c of data.cities) {
    const off = isCityOff(c.city as City, data.date);
    const acc = off ? "OFF" : c.accuracy === null ? "-" : `${c.accuracy}%`;
    lines.push(
      `${c.city.padEnd(13)} ${acc.padStart(5)} ${String(c.open).padStart(5)} ${String(c.ppBox).padStart(4)}   ${off ? OFF_LABEL : c.topIssue ?? "-"}`
    );
  }
  const withCounts = data.cities.filter((c) => c.counts);
  if (withCounts.length > 0) {
    lines.push("");
    lines.push("MOVEMENT SUMMARY (Out/In per source; '-' = source did not report)");
    lines.push("CITY          REGISTER     ODOO        DELIVERY TR  GUARDS");
    for (const c of withCounts) {
      const k = c.counts!;
      const p = (out: number, inn: number, ok: boolean) =>
        (ok ? `${out}/${inn}` : "-/-").padEnd(12);
      lines.push(
        `${c.city.padEnd(13)} ${p(k.sheetOut, k.sheetIn, k.reported.S)}${p(k.odooOut, k.odooIn, k.reported.O)}${p(k.dtOut, k.dtIn, k.reported.D)}${p(k.physOut, k.physIn, k.reported.P)}`
      );
    }
  }
  lines.push("");
  if (attachmentNote) lines.push(`No city registers attached — ${attachmentNote}.`);
  lines.push("Automated report from the Cityfurnish Operations Portal.");
  return lines.join("\n");
}
