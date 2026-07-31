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

function tableLines(b: Extract<Block, { kind: "table" }>): string[] {
  const widths = b.columns.map((c, i) =>
    Math.max(c.label.length, ...b.rows.map((r) => (r[i]?.text ?? "").length))
  );
  const pad = (s: string, i: number) =>
    b.columns[i].align === "right" ? s.padStart(widths[i]) : s.padEnd(widths[i]);

  const lines = [b.columns.map((c, i) => pad(c.label.toUpperCase(), i)).join("  ")];
  lines.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of b.rows) lines.push(r.map((c, i) => pad(c.text, i)).join("  "));
  if (b.footnote) lines.push("", b.footnote);
  return lines;
}

// Shading for a plaintext bar, densest first. Four steps because the coverage
// bar has four segments (all four / three / two / one source); a caller with
// more wraps around, which degrades the shading rather than the meaning — the
// caption carries the numbers regardless.
const BAR_GLYPHS = ["█", "▓", "▒", "░"];
const BAR_WIDTH = 44; // fits the 72-column plaintext part with room to indent

function barLines(b: Extract<Block, { kind: "bars" }>): string[] {
  const out: string[] = [];
  for (const r of b.rows) {
    out.push(r.label);
    // Round each segment down and hand the remainder to the largest, so the bar
    // is always exactly BAR_WIDTH wide. Rounding each independently drifts by a
    // character or two and the bars stop lining up down the page.
    const cells = r.segments.map((s) => Math.floor((Math.max(0, s.pct) / 100) * BAR_WIDTH));
    const used = cells.reduce((a, c) => a + c, 0);
    if (cells.length > 0 && used < BAR_WIDTH && used > 0) {
      let big = 0;
      for (let i = 1; i < cells.length; i++) if (cells[i] > cells[big]) big = i;
      cells[big] += BAR_WIDTH - used;
    }
    const bar = cells.map((n, i) => BAR_GLYPHS[i % BAR_GLYPHS.length].repeat(n)).join("");
    if (bar) out.push(`  ${bar}`);
    out.push(`  ${r.caption}`);
  }
  if (b.legend) out.push("", b.legend);
  return out;
}

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
    case "bars":
      return barLines(b);
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
  for (const s of sections) {
    if (s.title) out.push(s.title.toUpperCase(), "");
    for (const b of s.blocks) {
      out.push(...blockLines(b));
      out.push("");
    }
  }
  out.push("Automated from the Cityfurnish Operations Portal. Every term is explained on the dashboard.");
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}
