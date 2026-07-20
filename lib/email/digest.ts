// Builds the daily reconciliation digest — the data shape + the email HTML/text.
// Two producers: from a fresh engine run (cron path) and from persisted
// variances (manual / test-send path), so the same email renders either way.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MultiCityRun } from "../engine/run";
import { VARIANCE } from "../engine/variance-names";

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
}

export interface DigestData {
  date: string; // business date reconciled (YYYY-MM-DD)
  generatedAt: string; // ISO timestamp
  totals: { total: number; real: number; info: number; high: number };
  cities: CityDigestRow[]; // sorted REAL desc
  sources?: { source: string; ok: boolean; rows: number }[];
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
  [VARIANCE.ODOO_ONLY]: "Odoo only",
  [VARIANCE.ODOO_POSTED_NEXT_DAY]: "Odoo late entry",
  [VARIANCE.OPS_ODOO_NO_DT]: "No DT scan",
  [VARIANCE.DT_ODOO_NO_SHEET]: "Sheet missing",
  [VARIANCE.GATE_OPS_ODOO_NO_DT]: "DT pending",
  [VARIANCE.GATE_ODOO_NO_OPS_DT]: "Ops/DT gap",
  [VARIANCE.OPS_DT_ODOO_PENDING]: "Odoo pending",
  [VARIANCE.FIELD_MISMATCH]: "Barcode text",
  [VARIANCE.DUPLICATE]: "Duplicate",
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
  let rows: {
    city: string;
    bucket: string;
    priority: string;
    status: string;
    variance_name: string;
  }[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from("variances")
      .select("city,bucket,priority,status,variance_name")
      .eq("business_date", businessDate)
      .range(from, from + 999);
    if (error) throw new Error(`buildDigestFromDb: ${error.message}`);
    rows = rows.concat(data ?? []);
    if (!data || data.length < 1000) break;
    from += 1000;
  }

  // Per-city movements / pp-box / real-count for accuracy + PP (the variance
  // table no longer carries PP-box or consumable rows — see run_city_stats).
  const { data: stats } = await db
    .from("run_city_stats")
    .select("city, movements, real_count, pp_box_count")
    .eq("business_date", businessDate);
  const statByCity = new Map((stats ?? []).map((s) => [s.city, s]));

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
    });
  }
  cities.sort((a, b) => b.open - a.open);

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
  };
}

function fmtDate(d: string): string {
  // "2026-07-13" → "13 July 2026" without TZ drift.
  const [y, m, day] = d.split("-").map(Number);
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  if (!y || !m || !day) return d;
  return `${day} ${months[m - 1]} ${y}`;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function digestSubject(data: DigestData): string {
  return `Cityfurnish Reconciliation — ${fmtDate(data.date)} — ${data.totals.real} to action`;
}

// Email-client-safe HTML: tables + inline styles only (no fl+grid, no <style>).
export function renderDigestHtml(data: DigestData, dashboardUrl?: string, notes?: string): string {
  const dateLabel = fmtDate(data.date);
  // Brand as a text wordmark, not an image. A hosted logo is unreliable in email:
  // Gmail strips inline/base64, and an /apple-icon.png on a protected Vercel
  // deployment URL 403s (shows a broken image). Plain styled text always renders.
  const brand = `<span style="font-size:22px;font-weight:800;letter-spacing:-0.4px;color:#111827;font-family:Helvetica,Arial,sans-serif;">Cityfurnish</span>`;
  const cityRows = data.cities
    .map((c) => {
      const flag = c.open > 0;
      const nameStyle = flag ? "color:#b91c1c;font-weight:700;" : "color:#111827;";
      const bg = flag ? "background:#fef2f2;" : "";
      const acc = c.accuracy === null ? "—" : `${c.accuracy}%`;
      return `
      <tr style="${bg}">
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;${nameStyle}">${esc(c.city)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:right;color:#111827;">${acc}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:right;${flag ? "color:#b91c1c;font-weight:700;" : "color:#6b7280;"}">${c.open}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:right;color:#6b7280;">${c.ppBox}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#374151;font-size:12px;">${c.topIssue ? esc(c.topIssue) : "—"}</td>
      </tr>`;
    })
    .join("");

  const sourceLine = data.sources
    ? `<p style="margin:0 0 4px;color:#6b7280;font-size:12px;">Sources: ${data.sources
        .map((s) => `${esc(s.source)} ${s.ok ? s.rows : "FAIL"}`)
        .join(" · ")}</p>`
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
<html><body style="margin:0;padding:0;background:#f3f4f6;font-family:Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
        <tr><td style="padding:28px 32px 20px;border-bottom:1px solid #e5e7eb;">
          <table role="presentation" width="100%"><tr>
            <td>${brand}</td>
            <td style="text-align:right;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#9ca3af;">Daily Digest</td>
          </tr></table>
          <h2 style="margin:18px 0 6px;font-size:18px;color:#111827;">Warehouse Reconciliation Report</h2>
          <p style="margin:0;color:#6b7280;font-size:13px;">${dateLabel} — business day reconciled (D-1).</p>
        </td></tr>

        ${noteBlock}

        <tr><td style="padding:24px 32px;background:#f9fafb;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:22px;"><tr>
            <td width="33%" style="padding:14px;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;text-align:center;">
              <div style="font-size:11px;color:#6b7280;margin-bottom:4px;">Total Variances</div>
              <div style="font-size:20px;font-weight:800;color:#111827;">${data.totals.total}</div>
            </td>
            <td width="8"></td>
            <td width="33%" style="padding:14px;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;text-align:center;">
              <div style="font-size:11px;color:#6b7280;margin-bottom:4px;">Need Action (REAL)</div>
              <div style="font-size:20px;font-weight:800;color:#b91c1c;">${data.totals.real}</div>
            </td>
            <td width="8"></td>
            <td width="33%" style="padding:14px;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;text-align:center;">
              <div style="font-size:11px;color:#6b7280;margin-bottom:4px;">Info Only</div>
              <div style="font-size:20px;font-weight:800;color:#111827;">${data.totals.info}</div>
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
          ${cta}
        </td></tr>

        <tr><td style="padding:20px 32px;border-top:1px solid #e5e7eb;background:#f9fafb;text-align:center;">
          ${sourceLine}
          <p style="margin:0;color:#9ca3af;font-size:12px;">Automated report from the Cityfurnish Operations Portal. Reply to this address to reach the Reconciliation team.</p>
          <p style="margin:6px 0 0;color:#d1d5db;font-size:11px;">© ${new Date().getFullYear()} Cityfurnish Logistics · Internal use only.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export function renderDigestText(data: DigestData, notes?: string): string {
  const lines: string[] = [];
  lines.push(`CITYFURNISH — Warehouse Reconciliation — ${fmtDate(data.date)}`);
  lines.push("");
  if (notes && notes.trim()) {
    lines.push(`NOTE FROM THE ADMIN: ${notes.trim()}`);
    lines.push("");
  }
  lines.push(`Total ${data.totals.total} | Need action (REAL) ${data.totals.real} | Info ${data.totals.info} | High ${data.totals.high}`);
  lines.push("");
  lines.push("CITY          ACC%   OPEN   PP   TOP GAP");
  for (const c of data.cities) {
    const acc = c.accuracy === null ? "-" : `${c.accuracy}%`;
    lines.push(
      `${c.city.padEnd(13)} ${acc.padStart(5)} ${String(c.open).padStart(5)} ${String(c.ppBox).padStart(4)}   ${c.topIssue ?? "-"}`
    );
  }
  lines.push("");
  lines.push("Automated report from the Cityfurnish Operations Portal.");
  return lines.join("\n");
}
