import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// WHY A SOURCE SCAN RATHER THAN A TYPE.
//
// The WRITE path is guaranteed by the compiler: barcode_display is a REQUIRED
// field on VarianceRowOut and MovementEvent, so a new construction site fails
// to build. The READ path has no such lock — `{v.barcode}` compiles perfectly
// and renders the fold, which is exactly how 57% of units came to display a
// string that exists in no source system.
//
// So the read path is enforced here instead. Every direct `.barcode` in a
// human-facing file must be listed below WITH A REASON. A new one fails this
// test, and the person who wrote it has to say which of the two they meant:
//
//   the LABEL  -> use shownBarcode(row) from lib/ui/barcode-display
//   the KEY    -> add it here, with why
//
// The point is not that the list is short. It is that the next person cannot
// add one silently, the way this whole class of bug arrived in the first place.

const ROOTS = ["app", "lib/ui", "lib/email", "lib/ai"];
const EXT = /\.tsx?$/;

/**
 * Sites that legitimately read the canonical. Keyed `file:line-ish` by the
 * matched line's own text so a reformat does not silently re-arm them.
 */
const ALLOWED: { file: string; snippet: string; why: string }[] = [
  {
    file: "app/(dashboard)/dashboard/variance-detail-modal.tsx",
    snippet: "barcode: v?.barcode ?? null",
    why: "The evidence lookup. /api/sources matches source_rows.barcode_canonical, so this MUST be the fold or the panel returns nothing.",
  },
  {
    file: "app/(dashboard)/dashboard/variance-detail-modal.tsx",
    snippet: "canonical={v.barcode}",
    why: "Passed in so each source line can show its own spelling only when it DIFFERS from the canonical.",
  },
  {
    file: "app/(dashboard)/dashboard/variance-detail-modal.tsx",
    snippet: "row.barcode?.toUpperCase()",
    why: "A source_rows row — this IS the raw spelling, not the fold.",
  },
  {
    file: "app/(dashboard)/dashboard/admin-dashboard.tsx",
    snippet: "rejecting.barcode",
    why: "Local dialog state, already populated with shownBarcode(v) at the call site.",
  },
  {
    file: "app/(dashboard)/dashboard/admin-dashboard.tsx",
    snippet: "resolving.barcode",
    why: "Local dialog state, already populated with shownBarcode(v) at the call site.",
  },
  {
    file: "app/(dashboard)/dashboard/manager-dashboard.tsx",
    snippet: "submitting.barcode",
    why: "Local dialog state, already populated with shownBarcode(v) at the call site.",
  },
  {
    file: "app/api/stock/units/route.ts",
    snippet: "barcodeCanonical: barcode",
    why: "Returned alongside the label so the client can still key on what the snapshot diff uses.",
  },
  {
    file: "lib/email/register-pdf.ts",
    snippet: "r.barcode",
    why: "Reads source_rows directly — already the raw spelling the warehouse wrote.",
  },
  {
    file: "lib/email/digest/build.ts",
    snippet: "barcode: r.barcode",
    why: "The follow-up snapshot key. Must mirror the variances unique key, which is canonical.",
  },
  {
    file: "lib/email/followup/snapshot.ts",
    snippet: "|${r.barcode}|",
    why: "flaggedKeyOf / unitKeyOf — cross-run diff keys, canonical by definition.",
  },
  {
    file: "lib/email/followup/compare.ts",
    snippet: "r.barcode",
    why: "Dedup and set-difference keying for the follow-up comparison.",
  },
  {
    file: "lib/ai/tools/barcode-journey.ts",
    snippet: ".eq(\"barcode\", canon)",
    why: "The lookup. Canonical on purpose — it is what lets a user paste FUMYGB… and find a row stored as FUMY6B….",
  },
  {
    file: "lib/ai/tools/flagged-items.ts",
    snippet: "?? r.barcode",
    why: "Fallback when the display column is absent (pre-0020 row).",
  },
  {
    file: "app/(dashboard)/stock-analyser/day-recheck-panel.tsx",
    snippet: "{u.barcode}",
    why: "Rendered, but /api/stock/units already resolves it to the display spelling before it leaves the server.",
  },
  {
    file: "app/api/stock/movements/route.ts",
    snippet: "Barcodes.add(r.barcode)",
    why: "Set membership for counting distinct units. Must be the canonical or one unit counts twice.",
  },
  {
    file: "app/api/stock/movements/route.ts",
    snippet: "a.barcodes.add(r.barcode)",
    why: "As above — a counting set, never rendered.",
  },
  {
    file: "app/api/stock/movements/route.ts",
    snippet: "allBarcodes.add(r.barcode)",
    why: "As above — a counting set, never rendered.",
  },
  {
    file: "app/api/stock/units/route.ts",
    snippet: "barcode: d.barcode",
    why: "Builds the unit key that the cross-run snapshot diff matches on.",
  },
  {
    file: "lib/email/register-pdf.ts",
    snippet: "String(a.barcode).localeCompare",
    why: "Sort order for the printed register. Reads source_rows, so already the raw spelling.",
  },
  {
    file: "lib/ai/tools/barcode-journey.ts",
    snippet: "String(args.barcode ?? \"\")",
    why: "The user's own typing, before canonicalization. Not a stored value.",
  },
  {
    file: "lib/ui/barcode-display.ts",
    snippet: "row.barcode",
    why: "The helper itself.",
  },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next") continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (EXT.test(e)) out.push(full);
  }
  return out;
}

describe("the fold never reaches a screen again", () => {
  it("every direct .barcode read in a human-facing file is accounted for", () => {
    const offenders: string[] = [];

    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const rel = file.replace(/\\/g, "/");
        const lines = readFileSync(file, "utf-8").split("\n");
        lines.forEach((line, i) => {
          // Only DIRECT property reads. barcode_display, barcode_canonical,
          // shownBarcode and the string literal "barcode" are all fine.
          if (!/\.barcode\b/.test(line)) return;
          if (/barcode_display|barcode_canonical|shownBarcode|displayBarcode/.test(line)) return;
          // Comments discuss this distinction constantly and render nothing.
          const t = line.trim();
          if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
          const ok = ALLOWED.some((a) => rel.endsWith(a.file) && line.includes(a.snippet));
          if (!ok) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
        });
      }
    }

    expect(
      offenders,
      "A new direct .barcode read appeared in a human-facing file.\n" +
        "If it is a LABEL a person reads, use shownBarcode(row) from lib/ui/barcode-display.\n" +
        "If it is a KEY (a join, a dedup key, a lookup), add it to ALLOWED in this file with the reason.\n\n" +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("the allowlist itself stays honest — every entry still matches something", () => {
    // A stale exemption is worse than none: it reads as a considered decision
    // while guarding a line that no longer exists.
    const all = ROOTS.flatMap(walk).map((f) => ({
      rel: f.replace(/\\/g, "/"),
      text: readFileSync(f, "utf-8"),
    }));
    const dead = ALLOWED.filter(
      (a) => !all.some((f) => f.rel.endsWith(a.file) && f.text.includes(a.snippet))
    );
    expect(dead.map((d) => `${d.file} :: ${d.snippet}`), "stale allowlist entries").toEqual([]);
  });
});
