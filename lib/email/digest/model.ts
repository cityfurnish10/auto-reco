// The neutral section model both renderers consume.
//
// WHY THIS EXISTS: the HTML and plaintext bodies used to be two hand-maintained
// implementations, and they had already drifted — the plaintext reader got no
// dashboard link at all, no legend, and a truncated version of the caveat that
// explains a missing source. Nobody noticed, because nobody reads the text part
// until an email client decides to show it.
//
// So: buildSections() produces this model once, and each renderer turns it into
// its own syntax. Both switch exhaustively on `kind` with a `never` default, so
// adding a block is a COMPILE ERROR in whichever renderer forgot it.

export type Tone = "normal" | "muted" | "danger" | "warn" | "good";
export type Align = "left" | "right";

/**
 * Heat level for a table cell's BACKGROUND, 0 (nothing) to 4 (worst).
 *
 * Separate from `tone`, which colours TEXT. A heatmap needs a filled cell — the
 * eye finds the hot corner of a grid long before it reads any number — and
 * reusing `tone` for that would repaint every existing table.
 */
export type Heat = 0 | 1 | 2 | 3 | 4;

export interface Cell {
  text: string;
  tone?: Tone;
  strong?: boolean;
  align?: Align;
  heat?: Heat;
}

/**
 * One city's grouped column chart.
 *
 * EVERY NUMBER ALSO LIVES IN `caption`. The columns carry values so the HTML
 * renderer can size them, but the caption is what the anti-drift test matches
 * and what a plaintext reader gets — the two renderers draw this completely
 * differently and can only be checked against each other through prose.
 *
 * VALUES ARE ABSOLUTE, NOT PERCENTAGES, and the renderer scales every row
 * against the largest value across ALL rows. That shared scale is the point: a
 * per-row percentage would draw Hyderabad's 18 movements the same height as
 * Mumbai's 172 and quietly imply they carry equal weight.
 */
export interface BarRow {
  label: string;
  /** Under the label — "150 moved". */
  sub?: string;
  /** A pill under the sub — "Guard ✓" / "No guard". */
  badge?: { text: string; tone: Tone };
  caption: string;
  segments: { tone: Tone; value: number }[];
}

/** One entry in a chart's key. */
export interface LegendItem {
  tone: Tone;
  text: string;
}

export type Block =
  | { kind: "para"; text: string; tone?: Tone }
  | { kind: "callout"; tone: "warn" | "danger" | "note"; title: string; lines: string[] }
  | { kind: "table"; columns: { label: string; align?: Align }[]; rows: Cell[][]; footnote?: string }
  | { kind: "list"; items: { text: string; sub?: string; tone?: Tone }[] }
  | { kind: "bars"; rows: BarRow[]; keys?: LegendItem[]; legend?: string }
  | { kind: "cta"; label: string; href: string };

export interface Section {
  id: string;
  title?: string;
  blocks: Block[];
}

/**
 * Every user-visible string in a section model, for tests.
 *
 * The anti-drift test walks this and asserts each string reaches BOTH rendered
 * outputs. That is strictly stronger than a snapshot: it fails the moment a
 * renderer skips a block, rather than when someone remembers to re-approve.
 */
export function visibleStrings(sections: Section[]): string[] {
  const out: string[] = [];
  for (const s of sections) {
    if (s.title) out.push(s.title);
    for (const b of s.blocks) {
      switch (b.kind) {
        case "para":
          out.push(b.text);
          break;
        case "callout":
          out.push(b.title, ...b.lines);
          break;
        case "table":
          out.push(...b.columns.map((c) => c.label));
          for (const row of b.rows) out.push(...row.map((c) => c.text));
          if (b.footnote) out.push(b.footnote);
          break;
        case "list":
          for (const i of b.items) {
            out.push(i.text);
            if (i.sub) out.push(i.sub);
          }
          break;
        case "bars":
          // Labels, subs, badges, captions, the key and the legend. NOT the
          // segment values — those are geometry, and the caption already
          // spells them out, which is what lets the two renderers draw the same
          // data in completely different ways.
          for (const r of b.rows) {
            out.push(r.label, r.caption);
            if (r.sub) out.push(r.sub);
            if (r.badge) out.push(r.badge.text);
          }
          for (const k of b.keys ?? []) out.push(k.text);
          if (b.legend) out.push(b.legend);
          break;
        case "cta":
          // The label only. The href is a link TARGET, not visible copy — in
          // HTML it lives in an attribute, so a body-text comparison would
          // never find it. The link's presence is asserted separately.
          out.push(b.label);
          break;
        default: {
          const never: never = b;
          throw new Error(`visibleStrings: unhandled block ${JSON.stringify(never)}`);
        }
      }
    }
  }
  return out.filter((s) => s.trim() !== "");
}
