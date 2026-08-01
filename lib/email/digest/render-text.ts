// Plaintext part of the same email.
//
// THIS FILE EMITS STRUCTURE ONLY — padding, dashes, bullets. Every character a
// recipient reads comes from sections.ts.
//
// Column widths are COMPUTED from the model, not hard-coded. The previous
// renderer hard-coded padEnd(13)/padStart(5) and a literal header string, so
// adding a column silently broke the alignment in one renderer and not the
// other. It also, less visibly, omitted the dashboard link entirely.

import type { Block, Section } from "./model";

// Shading for a plaintext bar. Hoisted out of the retired grouped-column
// renderer so the block glyph survives it.
const BAR_GLYPH = "█";
const CELL_BAR_WIDTH = 10;

/**
 * A cell's printable string — the text, plus its bar when it has one.
 *
 * Built BEFORE the column-width pass below, which measures `.length`: appending
 * the glyphs afterwards would leave every column short by the bar and the table
 * would shear.
 */
function cellText(c: { text: string; bar?: number }): string {
  if (c.bar === undefined) return c.text;
  const filled = Math.max(0, Math.min(CELL_BAR_WIDTH, Math.round((c.bar / 100) * CELL_BAR_WIDTH)));
  return filled > 0 ? `${c.text} ${BAR_GLYPH.repeat(filled)}` : c.text;
}

function tableLines(b: Extract<Block, { kind: "table" }>): string[] {
  const widths = b.columns.map((c, i) =>
    Math.max(c.label.length, ...b.rows.map((r) => (r[i] ? cellText(r[i]) : "").length))
  );
  const pad = (s: string, i: number) =>
    b.columns[i].align === "right" ? s.padStart(widths[i]) : s.padEnd(widths[i]);

  const lines = [b.columns.map((c, i) => pad(c.label.toUpperCase(), i)).join("  ")];
  lines.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of b.rows) lines.push(r.map((c, i) => pad(cellText(c), i)).join("  "));
  if (b.footnote) lines.push("", b.footnote);
  return lines;
}

// Shading for a plaintext bar, densest first — one glyph per series, matching
// the order of the HTML chart's key.
const BAR_GLYPHS = ["█", "▓", "▒", "░"];
const BAR_WIDTH = 40; // fits a 72-column part with room to indent


function blockLines(b: Block): string[] {
  switch (b.kind) {
    case "para":
      return [b.text];
    case "callout":
      return [`** ${b.title.toUpperCase()} **`, ...b.lines];
    case "table":
      return tableLines(b);
    case "list":
      return b.items.flatMap((i) => (i.sub ? [`- ${i.text}`, `  ${i.sub}`] : [`- ${i.text}`]));
    case "cta":
      // The old plaintext renderer dropped this, so a text-only reader had no
      // way to reach the dashboard at all.
      return [`${b.label}: ${b.href}`];
    default: {
      const never: never = b;
      throw new Error(`render-text: unhandled block ${JSON.stringify(never)}`);
    }
  }
}

export function renderText(sections: Section[], date: string, kicker: string): string {
  const out: string[] = [`CITYFURNISH — ${kicker} — ${date}`, ""];
  let first = true;
  for (const s of sections) {
    // The same section divider the HTML draws as a rule.
    if (!first) out.push("─".repeat(40), "");
    first = false;
    if (s.title) out.push(s.title.toUpperCase(), "");
    for (const b of s.blocks) {
      out.push(...blockLines(b));
      out.push("");
    }
  }
  out.push("Automated from the Cityfurnish Operations Portal. Every term is explained on the dashboard.");
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}
