// Email-client-safe HTML: tables + inline styles only. No <style>, no flex, no
// grid, no classes — Gmail strips them.
//
// THIS FILE EMITS STRUCTURE ONLY. Tags, inline styles, spacing, rules. Every
// character a recipient reads comes from sections.ts. If you are about to type
// a word here, it belongs there — that rule is the only thing keeping this and
// render-text.ts saying the same thing.

import type { Block, Cell, Section, Tone } from "./model";

// Only & < > were escaped before. Quotes matter because esc() feeds attributes
// (href, and any future title=""), and DB text carries apostrophes routinely.
export const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const TONE_COLOR: Record<Tone, string> = {
  normal: "#111827",
  muted: "#6b7280",
  danger: "#b91c1c",
  warn: "#b45309",
  good: "#047857",
};

const CALLOUT: Record<"warn" | "danger" | "note", { bg: string; border: string; fg: string }> = {
  danger: { bg: "#fef2f2", border: "#fecaca", fg: "#991b1b" },
  warn: { bg: "#fffbeb", border: "#fde68a", fg: "#92400e" },
  note: { bg: "#f9fafb", border: "#e5e7eb", fg: "#374151" },
};

// Heat 0-4 as a filled cell. Light enough at every step that the number on top
// stays readable — a heatmap that has to be squinted through is decoration.
const HEAT: Record<number, { bg: string; fg: string }> = {
  0: { bg: "#f9fafb", fg: "#d1d5db" },
  1: { bg: "#dcfce7", fg: "#166534" },
  2: { bg: "#fef3c7", fg: "#92400e" },
  3: { bg: "#fecaca", fg: "#991b1b" },
  4: { bg: "#dc2626", fg: "#ffffff" },
};

function cellHtml(c: Cell): string {
  const heat = c.heat === undefined ? null : HEAT[c.heat];
  const color = heat ? heat.fg : TONE_COLOR[c.tone ?? "normal"];
  const weight = c.strong || (c.heat ?? 0) >= 3 ? "600" : "400";
  const bg = heat ? `background:${heat.bg};` : "";
  // Full gridlines and centred data, per the owner (2026-08-01). The model's
  // per-cell `align` still drives the PLAINTEXT columns; here every cell is
  // centred inside a real grid. Heat cells keep their white tile hairline —
  // that IS the heatmap's grid.
  const border = heat ? "border:2px solid #ffffff;" : "border:1px solid #e5e7eb;";
  return `<td style="padding:8px 10px;${border}${bg}font-size:13px;color:${color};font-weight:${weight};text-align:center;">${esc(c.text)}</td>`;
}

function blockHtml(b: Block): string {
  switch (b.kind) {
    case "para":
      return `<p style="margin:0 0 10px;font-size:14px;line-height:1.55;color:${TONE_COLOR[b.tone ?? "normal"]};${b.strong ? "font-weight:700;" : ""}">${esc(b.text)}</p>`;

    case "callout": {
      const c = CALLOUT[b.tone];
      const lines = b.lines
        .map((l) => `<p style="margin:4px 0 0;font-size:13px;line-height:1.5;color:${c.fg};">${esc(l)}</p>`)
        .join("");
      return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 14px;"><tr><td style="background:${c.bg};border:1px solid ${c.border};border-radius:8px;padding:12px 14px;">
        <p style="margin:0;font-size:13px;font-weight:700;color:${c.fg};">${esc(b.title)}</p>${lines}
      </td></tr></table>`;
    }

    case "table": {
      const head = b.columns
        .map(
          (col) =>
            `<th style="padding:8px 10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:center;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#6b7280;font-weight:600;">${esc(col.label)}</th>`
        )
        .join("");
      const body = b.rows.map((r) => `<tr>${r.map(cellHtml).join("")}</tr>`).join("");
      const foot = b.footnote
        ? `<p style="margin:8px 0 0;font-size:12px;color:#9ca3af;">${esc(b.footnote)}</p>`
        : "";
      return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;margin:0 0 12px;"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${foot}`;
    }

    case "list": {
      const items = b.items
        .map((i) => {
          const sub = i.sub
            ? `<div style="margin-top:2px;font-size:12px;color:#6b7280;">${esc(i.sub)}</div>`
            : "";
          // A left rule instead of a bullet glyph: it carries the tier colour,
          // and bullets render inconsistently across mail clients.
          return `<tr><td style="padding:8px 0 8px 12px;border-left:3px solid ${TONE_COLOR[i.tone ?? "normal"]};font-size:13px;line-height:1.5;color:#111827;">${esc(i.text)}${sub}</td></tr>`;
        })
        .join(`<tr><td style="height:6px;line-height:6px;font-size:0;">&nbsp;</td></tr>`);
      return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 12px;">${items}</table>`;
    }

    case "bars": {
      // A grouped column chart, built from nested tables with FIXED PIXEL
      // HEIGHTS. No div, no flex, no background-image, no SVG, and above all no
      // CSS transform — Outlook's Word engine drops every one of them, which is
      // why the value sits ABOVE each column rather than rotated inside it.
      //
      // One shared scale across every city: heights are measured against the
      // largest value in the whole chart, so Mumbai's 107 towers over
      // Hyderabad's 13 exactly as the numbers do. Scaling per city would draw
      // two very different days as the same picture.
      const PLOT = 120; // px for the tallest column
      const max = Math.max(1, ...b.rows.flatMap((r) => r.segments.map((s) => s.value)));

      const groups = b.rows
        .map((r) => {
          const cols = r.segments
            .map((s) => {
              // Zero keeps its slot — the gap where Mumbai's green bar should
              // be is the whole point of the chart — but draws no block.
              const h = s.value <= 0 ? 0 : Math.max(3, Math.round((s.value / max) * PLOT));
              const cap = s.value > 0
                ? `<div style="font-size:10px;line-height:12px;color:#6b7280;">${esc(String(s.value))}</div>`
                : `<div style="font-size:10px;line-height:12px;color:#ffffff;">&nbsp;</div>`;
              const block = h > 0
                ? `<div style="width:16px;height:${h}px;background:${TONE_COLOR[s.tone]};border-radius:2px 2px 0 0;font-size:0;line-height:0;">&nbsp;</div>`
                : "";
              return `<td valign="bottom" style="padding:0 3px;text-align:center;">${cap}${block}</td>`;
            })
            .join("");
          const badge = r.badge
            ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:3px auto 0;"><tr><td style="padding:2px 7px;border-radius:9px;background:${r.badge.tone === "good" ? "#dcfce7" : "#f3f4f6"};font-size:10px;color:${r.badge.tone === "good" ? "#166534" : "#6b7280"};">${esc(r.badge.text)}</td></tr></table>`
            : "";
          const sub = r.sub
            ? `<div style="font-size:11px;line-height:15px;color:#6b7280;">${esc(r.sub)}</div>`
            : "";
          // A nested two-row table with a FIXED-HEIGHT plot row. The axis line
          // is the border between the rows, and fixing the plot height puts
          // that border at exactly the same y in every group — before this,
          // each group bottom-aligned its whole stack, so a city with no
          // columns (weekly off) or no badge had a shorter stack and its
          // baseline floated above its neighbours'.
          return `<td valign="top" style="padding:0 6px;">
            <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
              <tr><td height="${PLOT + 14}" valign="bottom" align="center" style="height:${PLOT + 14}px;">
                ${cols ? `<table role="presentation" cellpadding="0" cellspacing="0" align="center"><tr>${cols}</tr></table>` : `<div style="font-size:0;line-height:0;">&nbsp;</div>`}
              </td></tr>
              <tr><td align="center" style="border-top:1px solid #e5e7eb;padding-top:5px;text-align:center;">
                <div style="font-size:12px;font-weight:600;color:#111827;">${esc(r.label)}</div>
                ${sub}${badge}
              </td></tr>
            </table>
          </td>`;
        })
        .join("");

      const keys = (b.keys ?? [])
        .map(
          (k) =>
            `<td style="padding:0 8px;font-size:11px;color:#6b7280;white-space:nowrap;"><span style="display:inline-block;width:9px;height:9px;background:${TONE_COLOR[k.tone]};border-radius:2px;">&nbsp;</span> ${esc(k.text)}</td>`
        )
        .join("");
      const keyRow = keys
        ? `<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:12px auto 0;"><tr>${keys}</tr></table>`
        : "";

      // NO CAPTIONS HERE. Each column already carries its own value above it,
      // so restating them as prose underneath was five paragraphs of numbers
      // the reader had just looked at. They render in the text part only, where
      // the bar is block glyphs and carries nothing.
      const legend = b.legend
        ? `<p style="margin:14px 0 0;font-size:12px;line-height:1.5;color:#6b7280;">${esc(b.legend)}</p>`
        : "";

      return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 6px;"><tr>${groups}</tr></table>${keyRow}${legend}`;
    }

    case "cta":
      return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 0;"><tr><td style="background:#111827;border-radius:8px;">
        <a href="${esc(b.href)}" style="display:inline-block;padding:10px 18px;color:#ffffff;font-size:13px;font-weight:600;text-decoration:none;">${esc(b.label)} &rarr;</a>
      </td></tr></table>`;

    default: {
      const never: never = b;
      throw new Error(`render-html: unhandled block ${JSON.stringify(never)}`);
    }
  }
}

export function renderHtml(sections: Section[], date: string, kicker: string): string {
  // A rule and breathing room between every pair of sections, per the owner.
  const DIVIDER =
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:22px 0;"><tr><td style="border-top:1px solid #e5e7eb;font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
  const body = sections
    .map((s) => {
      const title = s.title
        ? `<p style="margin:0 0 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#6b7280;">${esc(s.title)}</p>`
        : "";
      return title + s.blocks.map(blockHtml).join("");
    })
    .join(DIVIDER);

  // Brand logo from the public CDN. The old objection to images was specific:
  // inline/base64 (stripped by Gmail) and the deployment-protected Vercel URL
  // (403s into a broken frame). media.cityfurnish.com is public, so a plain
  // remote <img> works; the alt text keeps the wordmark for clients that block
  // remote images until the reader opts in. Height only, so clients scale the
  // width proportionally — Outlook honours the attribute where it ignores CSS.
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f3f4f6;padding:24px 12px;"><tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="width:100%;max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;">
      <tr><td style="padding:22px 28px 0;">
        <img src="https://media.cityfurnish.com/sagepilot/png/cityfurnish-logo-purple.png" alt="CITYFURNISH" height="28" style="height:28px;display:block;border:0;" />
        <p style="margin:2px 0 0;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.4px;color:#9ca3af;">${esc(kicker)} &middot; ${esc(date)}</p>
      </td></tr>
      <tr><td style="padding:16px 28px 26px;">${body}</td></tr>
      <tr><td style="padding:16px 28px;border-top:1px solid #e5e7eb;background:#f9fafb;">
        <p style="margin:0;font-size:11px;color:#9ca3af;">Automated from the Cityfurnish Operations Portal. Reply to this address to reach the team. Every term is explained on the dashboard.</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}
