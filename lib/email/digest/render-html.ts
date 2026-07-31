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

function cellHtml(c: Cell): string {
  const color = TONE_COLOR[c.tone ?? "normal"];
  const weight = c.strong ? "600" : "400";
  const align = c.align ?? "left";
  return `<td style="padding:8px 10px;border-top:1px solid #f3f4f6;font-size:13px;color:${color};font-weight:${weight};text-align:${align};">${esc(c.text)}</td>`;
}

function blockHtml(b: Block): string {
  switch (b.kind) {
    case "para":
      return `<p style="margin:0 0 10px;font-size:14px;line-height:1.55;color:${TONE_COLOR[b.tone ?? "normal"]};">${esc(b.text)}</p>`;

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
            `<th style="padding:8px 10px;text-align:${col.align ?? "left"};font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#6b7280;font-weight:600;">${esc(col.label)}</th>`
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
      // Percentage-width <td>s inside a fixed-layout table — the one bar
      // technique that survives both Gmail and Outlook. No div, no flex, no
      // background-image, no SVG: Outlook's Word engine drops all four.
      //
      // font-size:0/line-height:0 with a &nbsp; is what gives a <td> a reliable
      // height in Outlook; an empty <td> collapses there.
      const rows = b.rows
        .map((r) => {
          const segs = r.segments
            // A zero-width <td> still renders a 1px hairline in Outlook, so
            // empty segments are dropped rather than emitted at width="0%".
            .filter((s) => s.pct > 0)
            .map(
              (s) =>
                `<td width="${s.pct.toFixed(2)}%" style="width:${s.pct.toFixed(2)}%;background:${TONE_COLOR[s.tone]};font-size:0;line-height:0;height:10px;">&nbsp;</td>`
            )
            .join("");
          // The whole caption in ONE cell — stripTags() in the anti-drift test
          // turns every tag into a space, so a caption split across cells could
          // never be matched.
          const bar = segs
            ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="table-layout:fixed;border-collapse:collapse;border-radius:3px;overflow:hidden;margin:4px 0 3px;"><tr>${segs}</tr></table>`
            : "";
          return `<tr><td style="padding:0 0 12px;">
            <p style="margin:0;font-size:13px;font-weight:600;color:#111827;">${esc(r.label)}</p>${bar}
            <p style="margin:0;font-size:12px;line-height:1.45;color:#6b7280;">${esc(r.caption)}</p>
          </td></tr>`;
        })
        .join("");
      const legend = b.legend
        ? `<p style="margin:2px 0 10px;font-size:12px;line-height:1.5;color:#6b7280;">${esc(b.legend)}</p>`
        : "";
      return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 4px;">${rows}</table>${legend}`;
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
  const body = sections
    .map((s) => {
      const title = s.title
        ? `<p style="margin:18px 0 8px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#6b7280;">${esc(s.title)}</p>`
        : "";
      return title + s.blocks.map(blockHtml).join("");
    })
    .join("");

  // Brand as a text wordmark, not an image: Gmail strips inline/base64, and a
  // hosted icon on a protected deployment URL 403s into a broken image.
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f3f4f6;padding:24px 12px;"><tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="width:100%;max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;">
      <tr><td style="padding:22px 28px 0;">
        <p style="margin:0;font-size:15px;font-weight:800;letter-spacing:-.2px;color:#111827;">CITYFURNISH</p>
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
