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

export interface Cell {
  text: string;
  tone?: Tone;
  strong?: boolean;
  align?: Align;
}

export type Block =
  | { kind: "para"; text: string; tone?: Tone }
  | { kind: "callout"; tone: "warn" | "danger" | "note"; title: string; lines: string[] }
  | { kind: "table"; columns: { label: string; align?: Align }[]; rows: Cell[][]; footnote?: string }
  | { kind: "list"; items: { text: string; sub?: string; tone?: Tone }[] }
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
